import { isEqual } from 'lodash';

import { locationUtil, UrlQueryMap } from '@grafana/data';
import { config, getBackendSrv, isFetchError, locationService } from '@grafana/runtime';
import { sceneGraph } from '@grafana/scenes';
import { DashboardV2Spec } from '@grafana/schema/dist/esm/schema/dashboard/v2alpha0';
import { StateManagerBase } from 'app/core/services/StateManagerBase';
import { getMessageFromError, getMessageIdFromError, getStatusFromError } from 'app/core/utils/errors';
import { startMeasure, stopMeasure } from 'app/core/utils/metrics';
import { AnnoKeyFolder } from 'app/features/apiserver/types';
import { DashboardVersionError, DashboardWithAccessInfo } from 'app/features/dashboard/api/types';
import { isDashboardV2Resource, isDashboardV2Spec } from 'app/features/dashboard/api/utils';
import { dashboardLoaderSrv, DashboardLoaderSrvV2 } from 'app/features/dashboard/services/DashboardLoaderSrv';
import { getDashboardSrv } from 'app/features/dashboard/services/DashboardSrv';
import { emitDashboardViewEvent } from 'app/features/dashboard/state/analyticsProcessor';
import { trackDashboardSceneLoaded } from 'app/features/dashboard/utils/tracking';
import {
  DashboardDataDTO,
  DashboardDTO,
  DashboardRoutes,
  HomeDashboardRedirectDTO,
  isRedirectResponse,
} from 'app/types';

import { PanelEditor } from '../panel-edit/PanelEditor';
import { DashboardScene } from '../scene/DashboardScene';
import { buildNewDashboardSaveModel, buildNewDashboardSaveModelV2 } from '../serialization/buildNewDashboardSaveModel';
import { transformSaveModelSchemaV2ToScene } from '../serialization/transformSaveModelSchemaV2ToScene';
import { transformSaveModelToScene } from '../serialization/transformSaveModelToScene';
import { restoreDashboardStateFromLocalStorage } from '../utils/dashboardSessionState';

import { updateNavModel } from './utils';

export interface LoadError {
  status?: number;
  messageId?: string;
  message: string;
}

export interface DashboardScenePageState {
  dashboard?: DashboardScene;
  options?: LoadDashboardOptions;
  panelEditor?: PanelEditor;
  isLoading?: boolean;
  loadError?: LoadError;
}

export const DASHBOARD_CACHE_TTL = 500;

const LOAD_SCENE_MEASUREMENT = 'loadDashboardScene';

/** Only used by cache in loading home in DashboardPageProxy and initDashboard (Old arch), can remove this after old dashboard arch is gone */
export const HOME_DASHBOARD_CACHE_KEY = '__grafana_home_uid__';

interface DashboardCacheEntry<T> {
  dashboard: T;
  ts: number;
  cacheKey: string;
}

export interface LoadDashboardOptions {
  uid: string;
  route: DashboardRoutes;
  slug?: string;
  type?: string;
  urlFolderUid?: string;
  params?: {
    version: number;
    scopes: string[];
    timeRange: {
      from: string;
      to: string;
    };
    variables: UrlQueryMap;
  };
}

export type HomeDashboardDTO = DashboardDTO & {
  dashboard: DashboardDataDTO | DashboardV2Spec;
};

interface DashboardScenePageStateManagerLike<T> {
  fetchDashboard(options: LoadDashboardOptions): Promise<T | null>;
  getDashboardFromCache(cacheKey: string): T | null;
  loadDashboard(options: LoadDashboardOptions): Promise<void>;
  transformResponseToScene(rsp: T | null, options: LoadDashboardOptions): DashboardScene | null;
  reloadDashboard(params: LoadDashboardOptions['params']): Promise<void>;
  loadSnapshot(slug: string): Promise<void>;
  setDashboardCache(cacheKey: string, dashboard: T): void;
  clearSceneCache(): void;
  clearDashboardCache(): void;
  clearState(): void;
  getCache(): Record<string, DashboardScene>;
  useState: () => DashboardScenePageState;
}

abstract class DashboardScenePageStateManagerBase<T>
  extends StateManagerBase<DashboardScenePageState>
  implements DashboardScenePageStateManagerLike<T>
{
  abstract fetchDashboard(options: LoadDashboardOptions): Promise<T | null>;
  abstract reloadDashboard(params: LoadDashboardOptions['params']): Promise<void>;
  abstract transformResponseToScene(rsp: T | null, options: LoadDashboardOptions): DashboardScene | null;
  abstract loadSnapshotScene(slug: string): Promise<DashboardScene>;

  protected cache: Record<string, DashboardScene> = {};

  // This is a simplistic, short-term cache for DashboardDTOs to avoid fetching the same dashboard multiple times across a short time span.
  protected dashboardCache?: DashboardCacheEntry<T>;

  getCache(): Record<string, DashboardScene> {
    return this.cache;
  }

  public async loadSnapshot(slug: string) {
    try {
      const dashboard = await this.loadSnapshotScene(slug);

      this.setState({ dashboard: dashboard, isLoading: false });
    } catch (err) {
      const status = getStatusFromError(err);
      const message = getMessageFromError(err);
      const messageId = getMessageIdFromError(err);

      this.setState({
        isLoading: false,
        loadError: {
          status,
          message,
          messageId,
        },
      });
    }
  }

  public async loadDashboard(options: LoadDashboardOptions) {
    try {
      startMeasure(LOAD_SCENE_MEASUREMENT);
      const dashboard = await this.loadScene(options);
      if (!dashboard) {
        return;
      }

      if (config.featureToggles.preserveDashboardStateWhenNavigating && Boolean(options.uid)) {
        restoreDashboardStateFromLocalStorage(dashboard);
      }

      this.setState({ dashboard: dashboard, isLoading: false, options });
      const measure = stopMeasure(LOAD_SCENE_MEASUREMENT);
      const queryController = sceneGraph.getQueryController(dashboard);

      trackDashboardSceneLoaded(dashboard, measure?.duration);
      queryController?.startProfile('DashboardScene');

      if (options.route !== DashboardRoutes.New) {
        emitDashboardViewEvent({
          meta: dashboard.state.meta,
          uid: dashboard.state.uid,
          title: dashboard.state.title,
          id: dashboard.state.id,
        });
      }
    } catch (err) {
      const status = getStatusFromError(err);
      const message = getMessageFromError(err);
      const messageId = getMessageIdFromError(err);
      this.setState({
        isLoading: false,
        loadError: {
          status,
          message,
          messageId,
        },
      });
    }
  }

  private async loadScene(options: LoadDashboardOptions): Promise<DashboardScene | null> {
    this.setState({ dashboard: undefined, isLoading: true });
    const rsp = await this.fetchDashboard(options);

    if (!rsp) {
      return null;
    }

    return this.transformResponseToScene(rsp, options);
  }

  public getDashboardFromCache(cacheKey: string): T | null {
    const cachedDashboard = this.dashboardCache;

    if (
      cachedDashboard &&
      cachedDashboard.cacheKey === cacheKey &&
      Date.now() - cachedDashboard?.ts < DASHBOARD_CACHE_TTL
    ) {
      return cachedDashboard.dashboard;
    }

    return null;
  }

  public clearState() {
    getDashboardSrv().setCurrent(undefined);

    this.setState({
      dashboard: undefined,
      loadError: undefined,
      isLoading: false,
      panelEditor: undefined,
    });
  }

  public setDashboardCache(cacheKey: string, dashboard: T) {
    this.dashboardCache = { dashboard, ts: Date.now(), cacheKey };
  }

  public clearDashboardCache() {
    this.dashboardCache = undefined;
  }

  public getSceneFromCache(cacheKey: string) {
    return this.cache[cacheKey];
  }

  public setSceneCache(cacheKey: string, scene: DashboardScene) {
    this.cache[cacheKey] = scene;
  }

  public clearSceneCache() {
    this.cache = {};
  }
}

export class DashboardScenePageStateManager extends DashboardScenePageStateManagerBase<DashboardDTO> {
  transformResponseToScene(rsp: DashboardDTO | null, options: LoadDashboardOptions): DashboardScene | null {
    const fromCache = this.getSceneFromCache(options.uid);

    if (fromCache && fromCache.state.version === rsp?.dashboard.version) {
      return fromCache;
    }

    if (rsp?.dashboard) {
      const scene = transformSaveModelToScene(rsp);

      // Cache scene only if not coming from Explore, we don't want to cache temporary dashboard
      if (options.uid) {
        this.setSceneCache(options.uid, scene);
      }

      return scene;
    }

    throw new Error('Dashboard not found');
  }

  public async loadSnapshotScene(slug: string): Promise<DashboardScene> {
    const rsp = await dashboardLoaderSrv.loadSnapshot(slug);

    if (rsp?.dashboard) {
      const scene = transformSaveModelToScene(rsp);
      return scene;
    }

    throw new Error('Snapshot not found');
  }

  public async fetchDashboard({
    type,
    slug,
    uid,
    route,
    urlFolderUid,
    params,
  }: LoadDashboardOptions): Promise<DashboardDTO | null> {
    const cacheKey = route === DashboardRoutes.Home ? HOME_DASHBOARD_CACHE_KEY : uid;

    if (!params) {
      const cachedDashboard = this.getDashboardFromCache(cacheKey);

      if (cachedDashboard) {
        return cachedDashboard;
      }
    }

    let rsp: DashboardDTO | HomeDashboardRedirectDTO;

    try {
      switch (route) {
        case DashboardRoutes.New:
          rsp = await buildNewDashboardSaveModel(urlFolderUid);

          break;
        case DashboardRoutes.Home:
          // TODO: Move this fetching to APIClient.getHomeDashboard() to be able to redirect to the correct api depending on the format for the saved dashboard
          rsp = await getBackendSrv().get<HomeDashboardDTO | HomeDashboardRedirectDTO>('/api/dashboards/home');

          if (isRedirectResponse(rsp)) {
            const newUrl = locationUtil.stripBaseFromUrl(rsp.redirectUri);
            locationService.replace(newUrl);
            return null;
          }

          if (isDashboardV2Spec(rsp.dashboard)) {
            throw new Error(
              'You are trying to load a v2 dashboard spec as v1. Use DashboardScenePageStateManagerV2 instead.'
            );
          }

          if (rsp?.meta) {
            rsp.meta.canSave = false;
            rsp.meta.canShare = false;
            rsp.meta.canStar = false;
          }

          break;
        case DashboardRoutes.Provisioning: {
          return await dashboardLoaderSrv.loadDashboard('provisioning', slug, uid);
        }
        case DashboardRoutes.Public: {
          return await dashboardLoaderSrv.loadDashboard('public', '', uid);
        }
        default:
          const queryParams = params
            ? {
                version: params.version,
                scopes: params.scopes,
                from: params.timeRange.from,
                to: params.timeRange.to,
                ...params.variables,
              }
            : undefined;

          rsp = await dashboardLoaderSrv.loadDashboard(type || 'db', slug || '', uid, queryParams);

          if (route === DashboardRoutes.Embedded) {
            rsp.meta.isEmbedded = true;
          }
      }

      if (rsp.meta.url && route === DashboardRoutes.Normal) {
        const dashboardUrl = locationUtil.stripBaseFromUrl(rsp.meta.url);
        const currentPath = locationService.getLocation().pathname;

        if (dashboardUrl !== currentPath) {
          // Spread current location to persist search params used for navigation
          locationService.replace({
            ...locationService.getLocation(),
            pathname: dashboardUrl,
          });
          console.log('not correct url correcting', dashboardUrl, currentPath);
        }
      }

      // Populate nav model in global store according to the folder
      if (rsp.meta.folderUid) {
        await updateNavModel(rsp.meta.folderUid);
      }

      // Do not cache new dashboards
      this.setDashboardCache(cacheKey, rsp);
    } catch (e) {
      // Ignore cancelled errors
      if (isFetchError(e) && e.cancelled) {
        return null;
      }

      throw e;
    }

    return rsp;
  }

  public async reloadDashboard(params: LoadDashboardOptions['params']) {
    const stateOptions = this.state.options;

    if (!stateOptions) {
      return;
    }

    const options = {
      ...stateOptions,
      params,
    };

    // We shouldn't check all params since:
    // - version doesn't impact the new dashboard, and it's there for increased compatibility
    // - time range is almost always different for relative time ranges and absolute time ranges do not trigger subsequent reloads
    // - other params don't affect the dashboard content
    if (
      isEqual(options.params?.variables, stateOptions.params?.variables) &&
      isEqual(options.params?.scopes, stateOptions.params?.scopes)
    ) {
      return;
    }

    try {
      this.setState({ isLoading: true });

      const rsp = await this.fetchDashboard(options);
      const fromCache = this.getSceneFromCache(options.uid);

      if (fromCache && fromCache.state.version === rsp?.dashboard.version) {
        this.setState({ isLoading: false });
        return;
      }

      if (!rsp?.dashboard) {
        this.setState({
          isLoading: false,
          loadError: {
            status: 404,
            message: 'Dashboard not found',
          },
        });
        return;
      }

      const scene = transformSaveModelToScene(rsp);

      this.setSceneCache(options.uid, scene);

      this.setState({ dashboard: scene, isLoading: false, options });
    } catch (err) {
      const status = getStatusFromError(err);
      const message = getMessageFromError(err);
      this.setState({
        isLoading: false,
        loadError: {
          message,
          status,
        },
      });
    }
  }
}

export class DashboardScenePageStateManagerV2 extends DashboardScenePageStateManagerBase<
  DashboardWithAccessInfo<DashboardV2Spec>
> {
  private dashboardLoader = new DashboardLoaderSrvV2();

  public async loadSnapshotScene(slug: string): Promise<DashboardScene> {
    const rsp = await this.dashboardLoader.loadSnapshot(slug);

    if (rsp?.spec) {
      const scene = transformSaveModelSchemaV2ToScene(rsp);
      return scene;
    }

    throw new Error('Snapshot not found');
  }

  transformResponseToScene(
    rsp: DashboardWithAccessInfo<DashboardV2Spec> | null,
    options: LoadDashboardOptions
  ): DashboardScene | null {
    const fromCache = this.getSceneFromCache(options.uid);

    if (fromCache && fromCache.state.version === rsp?.metadata.generation) {
      return fromCache;
    }

    if (rsp) {
      const scene = transformSaveModelSchemaV2ToScene(rsp);

      // Cache scene only if not coming from Explore, we don't want to cache temporary dashboard
      if (options.uid) {
        this.setSceneCache(options.uid, scene);
      }

      return scene;
    }

    throw new Error('Dashboard not found');
  }

  reloadDashboard(params: LoadDashboardOptions['params']): Promise<void> {
    throw new Error('Method not implemented.');
  }

  public async fetchDashboard({
    type,
    slug,
    uid,
    route,
    urlFolderUid,
    params,
  }: LoadDashboardOptions): Promise<DashboardWithAccessInfo<DashboardV2Spec> | null> {
    const cacheKey = route === DashboardRoutes.Home ? HOME_DASHBOARD_CACHE_KEY : uid;
    if (!params) {
      const cachedDashboard = this.getDashboardFromCache(cacheKey);
      if (cachedDashboard) {
        return cachedDashboard;
      }
    }
    let rsp: DashboardWithAccessInfo<DashboardV2Spec>;
    try {
      switch (route) {
        case DashboardRoutes.New:
          rsp = await buildNewDashboardSaveModelV2(urlFolderUid);
          break;
        case DashboardRoutes.Home:
          // TODO: Move this fetching to APIClient.getHomeDashboard() to be able to redirect to the correct api depending on the format for the saved dashboard
          const dto = await getBackendSrv().get<HomeDashboardDTO | HomeDashboardRedirectDTO>('/api/dashboards/home');

          if (isRedirectResponse(dto)) {
            const newUrl = locationUtil.stripBaseFromUrl(dto.redirectUri);
            locationService.replace(newUrl);
            return null;
          }

          // if custom home dashboard is v2 spec already, ignore the spec transformation
          if (!isDashboardV2Resource(dto)) {
            throw new Error('Custom home dashboard is not a v2 spec');
          }

          rsp = dto;
          dto.access.canSave = false;
          dto.access.canShare = false;
          dto.access.canStar = false;

          break;
        case DashboardRoutes.Public: {
          return await this.dashboardLoader.loadDashboard('public', '', uid);
        }
        default:
          const queryParams = params
            ? {
                version: params.version,
                scopes: params.scopes,
                from: params.timeRange.from,
                to: params.timeRange.to,
                ...params.variables,
              }
            : undefined;
          rsp = await this.dashboardLoader.loadDashboard(type || 'db', slug || '', uid, queryParams);
          if (route === DashboardRoutes.Embedded) {
            throw new Error('Method not implemented.');
            // rsp.meta.isEmbedded = true;
          }
      }
      if (rsp.access.url && route === DashboardRoutes.Normal) {
        const dashboardUrl = locationUtil.stripBaseFromUrl(rsp.access.url);
        const currentPath = locationService.getLocation().pathname;
        if (dashboardUrl !== currentPath) {
          // Spread current location to persist search params used for navigation
          locationService.replace({
            ...locationService.getLocation(),
            pathname: dashboardUrl,
          });
          console.log('not correct url correcting', dashboardUrl, currentPath);
        }
      }
      // Populate nav model in global store according to the folder
      if (rsp.metadata.annotations?.[AnnoKeyFolder]) {
        await updateNavModel(rsp.metadata.annotations?.[AnnoKeyFolder]);
      }
      // Do not cache new dashboards
      this.setDashboardCache(cacheKey, rsp);
    } catch (e) {
      // Ignore cancelled errors
      if (isFetchError(e) && e.cancelled) {
        return null;
      }
      throw e;
    }
    return rsp;
  }
}

export class UnifiedDashboardScenePageStateManager extends DashboardScenePageStateManagerBase<
  DashboardDTO | DashboardWithAccessInfo<DashboardV2Spec>
> {
  private v1Manager: DashboardScenePageStateManager;
  private v2Manager: DashboardScenePageStateManagerV2;
  private activeManager: DashboardScenePageStateManager | DashboardScenePageStateManagerV2;

  constructor(initialState: Partial<DashboardScenePageState>) {
    super(initialState);
    this.v1Manager = new DashboardScenePageStateManager(initialState);
    this.v2Manager = new DashboardScenePageStateManagerV2(initialState);

    // Start with v2 if newDashboardLayout is enabled, otherwise v1
    this.activeManager = this.v1Manager;
  }

  private async withVersionHandling<T>(
    operation: (manager: DashboardScenePageStateManager | DashboardScenePageStateManagerV2) => Promise<T>
  ): Promise<T> {
    try {
      const result = await operation(this.activeManager);
      // need to sync the state of the active manager with the unified manager
      // in cases when components are subscribed to unified manager's state
      this.setState(this.activeManager.state);
      return result;
    } catch (error) {
      if (error instanceof DashboardVersionError) {
        const manager = error.data.storedVersion === 'v2alpha1' ? this.v2Manager : this.v1Manager;
        this.activeManager = manager;
        return await operation(manager);
      } else {
        throw error;
      }
    }
  }

  public async fetchDashboard(options: LoadDashboardOptions) {
    return this.withVersionHandling<DashboardDTO | DashboardWithAccessInfo<DashboardV2Spec> | null>((manager) =>
      manager.fetchDashboard(options)
    );
  }

  public async reloadDashboard(params: LoadDashboardOptions['params']) {
    return this.withVersionHandling((manager) => manager.reloadDashboard(params));
  }

  public getDashboardFromCache(uid: string) {
    return this.activeManager.getDashboardFromCache(uid);
  }

  transformResponseToScene(
    rsp: DashboardDTO | DashboardWithAccessInfo<DashboardV2Spec> | null,
    options: LoadDashboardOptions
  ): DashboardScene | null {
    if (!rsp) {
      return null;
    }

    if (isDashboardV2Resource(rsp)) {
      this.activeManager = this.v2Manager;
      return this.v2Manager.transformResponseToScene(rsp, options);
    }

    return this.v1Manager.transformResponseToScene(rsp, options);
  }

  public async loadSnapshotScene(slug: string): Promise<DashboardScene> {
    try {
      return await this.v1Manager.loadSnapshotScene(slug);
    } catch (error) {
      if (error instanceof DashboardVersionError && error.data.storedVersion === 'v2alpha1') {
        return await this.v2Manager.loadSnapshotScene(slug);
      }
      throw new Error('Snapshot not found');
    }
  }

  public async loadSnapshot(slug: string) {
    return this.withVersionHandling((manager) => manager.loadSnapshot(slug));
  }

  public clearDashboardCache() {
    this.v1Manager.clearDashboardCache();
    this.v2Manager.clearDashboardCache();
  }

  public clearSceneCache() {
    this.v1Manager.clearSceneCache();
    this.v2Manager.clearSceneCache();
    this.cache = {};
  }

  public getCache() {
    return this.activeManager.getCache();
  }

  public setDashboardCache(cacheKey: string, dashboard: DashboardDTO | DashboardWithAccessInfo<DashboardV2Spec>) {
    if (isDashboardV2Resource(dashboard)) {
      this.v2Manager.setDashboardCache(cacheKey, dashboard);
    } else {
      this.v1Manager.setDashboardCache(cacheKey, dashboard);
    }
  }
}

const managers: {
  v1?: DashboardScenePageStateManager;
  v2?: DashboardScenePageStateManagerV2;
  unified?: UnifiedDashboardScenePageStateManager;
} = {
  v1: undefined,
  v2: undefined,
  unified: undefined,
};

export function getDashboardScenePageStateManager(): UnifiedDashboardScenePageStateManager;
export function getDashboardScenePageStateManager(v: 'v1'): DashboardScenePageStateManager;
export function getDashboardScenePageStateManager(v: 'v2'): DashboardScenePageStateManagerV2;

export function getDashboardScenePageStateManager(v?: 'v1' | 'v2') {
  if (v === 'v1') {
    if (!managers.v1) {
      managers.v1 = new DashboardScenePageStateManager({});
    }
    return managers.v1;
  }

  if (v === 'v2') {
    if (!managers.v2) {
      managers.v2 = new DashboardScenePageStateManagerV2({});
    }
    return managers.v2;
  }

  if (!managers.unified) {
    managers.unified = new UnifiedDashboardScenePageStateManager({});
  }

  return managers.unified;
}
