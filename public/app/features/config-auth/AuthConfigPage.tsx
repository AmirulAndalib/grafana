import { css } from '@emotion/css';
import React, { useEffect } from 'react';
import { connect, ConnectedProps } from 'react-redux';

import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { Page } from 'app/core/components/Page/Page';
import { StoreState } from 'app/types';

import { ProviderCard } from './components/ProviderCard';
import { loadSettings } from './state/actions';
import { getAuthProviderInfo, getEnabledAuthProviders } from './utils';

interface OwnProps {}

export type Props = OwnProps & ConnectedProps<typeof connector>;

function mapStateToProps(state: StoreState) {
  return {
    settings: state.authConfig.settings,
  };
}

const mapDispatchToProps = {
  loadSettings,
};

const connector = connect(mapStateToProps, mapDispatchToProps);

export const AuthConfigPageUnconnected = ({ settings, loadSettings }: Props): JSX.Element => {
  const styles = useStyles2(getStyles);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const enabledAuthProviders = getEnabledAuthProviders(settings);
  console.log(enabledAuthProviders);

  return (
    <Page navId="authentication">
      <Page.Contents>
        <span>Authentication</span>
        <div className={styles.cardsContainer}>
          {enabledAuthProviders.map((provider) => (
            <ProviderCard
              key={provider}
              providerId={provider}
              configPath="admin/authentication"
              displayName={getAuthProviderInfo(provider).displayName}
              enabled={true}
            />
          ))}
        </div>
      </Page.Contents>
    </Page>
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  return {
    cardsContainer: css`
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(288px, 1fr));
      gap: ${theme.spacing(3)};
    `,
  };
};

const AuthConfigPage = connector(AuthConfigPageUnconnected);
export default AuthConfigPage;
