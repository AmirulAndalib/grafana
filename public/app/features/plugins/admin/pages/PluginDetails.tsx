import { css } from '@emotion/css';
import React from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, TabContent, Alert } from '@grafana/ui';
import { Layout } from '@grafana/ui/src/components/Layout/Layout';
import { Page } from 'app/core/components/Page/Page';
import { GrafanaRouteComponentProps } from 'app/core/navigation/types';
import { AppNotificationSeverity } from 'app/types';

import { Loader } from '../components/Loader';
import { PluginDetailsBody } from '../components/PluginDetailsBody';
import { PluginDetailsDisabledError } from '../components/PluginDetailsDisabledError';
import { PluginDetailsSignature } from '../components/PluginDetailsSignature';
import { usePluginDetailsTabs } from '../hooks/usePluginDetailsTabs';
import { usePluginInfo } from '../hooks/usePluginInfo';
import { useGetSingle, useFetchStatus, useFetchDetailsStatus } from '../state/hooks';
import { PluginTabIds } from '../types';

type Props = GrafanaRouteComponentProps<{ pluginId?: string }>;

export default function PluginDetails({ match, queryParams }: Props): JSX.Element | null {
  const {
    params: { pluginId = '' },
    url,
  } = match;
  const parentUrl = url.substring(0, url.lastIndexOf('/'));

  const plugin = useGetSingle(pluginId); // fetches the localplugin settings
  const { navModel, activePageId } = usePluginDetailsTabs(plugin, queryParams.page as PluginTabIds);
  const { actions, info } = usePluginInfo(plugin);
  const { isLoading: isFetchLoading } = useFetchStatus();
  const { isLoading: isFetchDetailsLoading } = useFetchDetailsStatus();
  const styles = useStyles2(getStyles);
  const subtitle = (
    <div className={styles.subtitle}>
      <div>{plugin?.description}</div>
      {plugin?.details?.links && plugin.details.links.length > 0 && (
        <div className={styles.links}>
          {plugin.details.links.map((link) => (
            <a key={link.name} href={link.url} className="external-link">
              {link.name}
            </a>
          ))}
        </div>
      )}
    </div>
  );

  if (isFetchLoading || isFetchDetailsLoading) {
    return (
      <Page navId="plugins">
        <Loader />
      </Page>
    );
  }

  if (!plugin) {
    return (
      <Layout justify="center" align="center">
        <Alert severity={AppNotificationSeverity.Warning} title="Plugin not found">
          That plugin cannot be found. Please check the url is correct or <br />
          go to the <a href={parentUrl}>plugin catalog</a>.
        </Alert>
      </Layout>
    );
  }

  return (
    <Page navId="plugins" pageNav={navModel} actions={actions} subTitle={subtitle} info={info}>
      <Page.Contents>
        <TabContent className={styles.tabContent}>
          <PluginDetailsSignature plugin={plugin} className={styles.alert} />
          <PluginDetailsDisabledError plugin={plugin} className={styles.alert} />
          <PluginDetailsBody queryParams={queryParams} plugin={plugin} pageId={activePageId} />
        </TabContent>
      </Page.Contents>
    </Page>
  );
}

export const getStyles = (theme: GrafanaTheme2) => {
  return {
    alert: css`
      margin-bottom: ${theme.spacing(2)};
    `,
    links: css`
      display: flex;
      flex-direction: row;
      gap: ${theme.spacing(0.5)};
    `,
    subtitle: css`
      display: flex;
      flex-direction: column;
    `,
    // Needed due to block formatting context
    tabContent: css`
      overflow: auto;
      height: 100%;
    `,
  };
};
