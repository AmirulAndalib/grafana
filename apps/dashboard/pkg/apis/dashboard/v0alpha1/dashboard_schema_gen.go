//
// Code generated by grafana-app-sdk. DO NOT EDIT.
//

package v0alpha1

import (
	"github.com/grafana/grafana-app-sdk/resource"
)

// schema is unexported to prevent accidental overwrites
var (
	schemaDashboard = resource.NewSimpleSchema("dashboard.grafana.app", "v0alpha1", &Dashboard{}, &DashboardList{}, resource.WithKind("Dashboard"),
		resource.WithPlural("dashboards"), resource.WithScope(resource.NamespacedScope))
	kindDashboard = resource.Kind{
		Schema: schemaDashboard,
		Codecs: map[resource.KindEncoding]resource.Codec{
			resource.KindEncodingJSON: &DashboardJSONCodec{},
		},
	}
)

// Kind returns a resource.Kind for this Schema with a JSON codec
func DashboardKind() resource.Kind {
	return kindDashboard
}

// Schema returns a resource.SimpleSchema representation of Dashboard
func DashboardSchema() *resource.SimpleSchema {
	return schemaDashboard
}

// Interface compliance checks
var _ resource.Schema = kindDashboard
