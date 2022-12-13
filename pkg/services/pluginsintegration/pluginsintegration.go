package pluginsintegration

import (
	"github.com/google/wire"

	pluginLib "github.com/grafana/grafana/pkg/plugins"
	"github.com/grafana/grafana/pkg/plugins/backendplugin/coreplugin"
	"github.com/grafana/grafana/pkg/plugins/backendplugin/provider"
	"github.com/grafana/grafana/pkg/plugins/config"
	"github.com/grafana/grafana/pkg/plugins/manager"
	"github.com/grafana/grafana/pkg/plugins/manager/client"
	"github.com/grafana/grafana/pkg/plugins/manager/loader"
	"github.com/grafana/grafana/pkg/plugins/manager/process"
	"github.com/grafana/grafana/pkg/plugins/manager/registry"
	"github.com/grafana/grafana/pkg/plugins/manager/signature"
	"github.com/grafana/grafana/pkg/plugins/manager/store"
	"github.com/grafana/grafana/pkg/plugins/plugincontext"
	"github.com/grafana/grafana/pkg/plugins/repo"
	"github.com/grafana/grafana/pkg/services/auth/jwt"
	"github.com/grafana/grafana/pkg/services/oauthtoken"
	"github.com/grafana/grafana/pkg/services/plugins"
	managerClient "github.com/grafana/grafana/pkg/services/pluginsintegration/client"
	"github.com/grafana/grafana/pkg/services/pluginsintegration/clientmiddleware"
	managerStore "github.com/grafana/grafana/pkg/services/pluginsintegration/store"
	"github.com/grafana/grafana/pkg/setting"
)

// WireSet provides a wire.ProviderSet of plugin providers.
var WireSet = wire.NewSet(
	config.ProvideConfig,
	store.ProvideService,
	wire.Bind(new(pluginLib.RendererManager), new(*store.Service)),
	wire.Bind(new(pluginLib.SecretsPluginManager), new(*store.Service)),

	ProvidePlugins,

	plugins.ProvideRouteResolver,
	wire.Bind(new(plugins.StaticRouteResolver), new(*plugins.RouteResolver)), // TODO

	plugins.ProvideErrorResolver,
	wire.Bind(new(plugins.PluginErrorResolver), new(*plugins.ErrorResolver)), // TODO

	ProvideClientDecorator,

	process.ProvideService,
	wire.Bind(new(process.Service), new(*process.Manager)),
	coreplugin.ProvideCoreRegistry,
	loader.ProvideService,
	wire.Bind(new(loader.Service), new(*loader.Loader)),
	manager.ProvideInstaller,
	registry.ProvideService,
	wire.Bind(new(registry.Service), new(*registry.InMemory)),
	repo.ProvideService,
	wire.Bind(new(repo.Service), new(*repo.Manager)),
	plugincontext.ProvideService,
)

var ProvidePlugins = wire.NewSet(
	managerStore.ProvideStoreService,
	wire.Bind(new(plugins.Store), new(*managerStore.Service)),
	wire.Bind(new(plugins.Installer), new(*managerStore.Service)),

	managerClient.ProvideClientService,
	wire.Bind(new(plugins.Client), new(*managerClient.Service)),
)

// WireExtensionSet provides a wire.ProviderSet of plugin providers that can be
// extended.
var WireExtensionSet = wire.NewSet(
	provider.ProvideService,
	wire.Bind(new(pluginLib.BackendFactoryProvider), new(*provider.Service)),
	signature.ProvideOSSAuthorizer,
	wire.Bind(new(pluginLib.PluginLoaderAuthorizer), new(*signature.UnsignedPluginAuthorizer)),
)

func ProvideClientDecorator(cfg *setting.Cfg, pCfg *config.Cfg,
	pluginRegistry registry.Service,
	oAuthTokenService oauthtoken.OAuthTokenService, pluginAuthService jwt.PluginAuthService) (*plugins.Decorator, error) {
	return NewClientDecorator(cfg, pCfg, pluginRegistry, oAuthTokenService, pluginAuthService)
}

func NewClientDecorator(cfg *setting.Cfg, pCfg *config.Cfg,
	pluginRegistry registry.Service,
	oAuthTokenService oauthtoken.OAuthTokenService, pluginAuthService jwt.PluginAuthService) (*plugins.Decorator, error) {
	c := client.ProvideService(pluginRegistry, pCfg, pluginAuthService)
	middlewares := CreateMiddlewares(cfg, oAuthTokenService)

	return plugins.NewDecorator(c, middlewares...)
}

func CreateMiddlewares(cfg *setting.Cfg, oAuthTokenService oauthtoken.OAuthTokenService) []plugins.ClientMiddleware {
	skipCookiesNames := []string{cfg.LoginCookieName}
	middlewares := []plugins.ClientMiddleware{
		clientmiddleware.NewClearAuthHeadersMiddleware(),
		clientmiddleware.NewOAuthTokenMiddleware(oAuthTokenService),
		clientmiddleware.NewCookiesMiddleware(skipCookiesNames),
	}

	return middlewares
}
