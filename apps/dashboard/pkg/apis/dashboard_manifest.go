//
// This file is generated by grafana-app-sdk
// DO NOT EDIT
//

package apis

import (
	"fmt"

	"github.com/grafana/grafana-app-sdk/app"
	"github.com/grafana/grafana-app-sdk/resource"

	v0alpha1 "github.com/grafana/grafana/apps/dashboard/pkg/apis/dashboard/v0alpha1"
	v1beta1 "github.com/grafana/grafana/apps/dashboard/pkg/apis/dashboard/v1beta1"
	v2alpha1 "github.com/grafana/grafana/apps/dashboard/pkg/apis/dashboard/v2alpha1"
	v2alpha2 "github.com/grafana/grafana/apps/dashboard/pkg/apis/dashboard/v2alpha2"
)

var appManifestData = app.ManifestData{
	AppName: "dashboard",
	Group:   "dashboard.grafana.app",
	Kinds: []app.ManifestKind{
		{
			Kind:       "Dashboard",
			Scope:      "Namespaced",
			Conversion: false,
			Versions: []app.ManifestKindVersion{
				{
					Name: "v0alpha1",
				},

				{
					Name: "v1beta1",
				},

				{
					Name: "v2alpha1",
				},

				{
					Name: "v2alpha2",
				},
			},
		},
	},
}

func LocalManifest() app.Manifest {
	return app.NewEmbeddedManifest(appManifestData)
}

func RemoteManifest() app.Manifest {
	return app.NewAPIServerManifest("dashboard")
}

var kindVersionToGoType = map[string]resource.Kind{
	"Dashboard/v0alpha1": v0alpha1.DashboardKind(),
	"Dashboard/v1beta1":  v1beta1.DashboardKind(),
	"Dashboard/v2alpha1": v2alpha1.DashboardKind(),
	"Dashboard/v2alpha2": v2alpha2.DashboardKind(),
}

// ManifestGoTypeAssociator returns the associated resource.Kind instance for a given Kind and Version, if one exists.
// If there is no association for the provided Kind and Version, exists will return false.
func ManifestGoTypeAssociator(kind, version string) (goType resource.Kind, exists bool) {
	goType, exists = kindVersionToGoType[fmt.Sprintf("%s/%s", kind, version)]
	return goType, exists
}
