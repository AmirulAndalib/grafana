package updatechecker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/infra/tracing"
	"github.com/grafana/grafana/pkg/setting"
	"github.com/hashicorp/go-version"
)

type GrafanaService struct {
	hasUpdate     bool
	latestVersion string

	enabled        bool
	grafanaVersion string
	httpClient     httpClient
	mutex          sync.RWMutex
	log            log.Logger
	tracer         tracing.Tracer
}

func ProvideGrafanaService(cfg *setting.Cfg, tracer tracing.Tracer) *GrafanaService {
	return &GrafanaService{
		enabled:        cfg.CheckForGrafanaUpdates,
		grafanaVersion: cfg.BuildVersion,
		httpClient: mustNewInstrumentedHTTPClient(
			&http.Client{Timeout: time.Second * 10},
			tracer,
			"grafana_update_checker",
		),
		log:    log.New("grafana.update.checker"),
		tracer: tracer,
	}
}

func (s *GrafanaService) IsDisabled() bool {
	return !s.enabled
}

func (s *GrafanaService) Run(ctx context.Context) error {
	s.checkForUpdates(ctx)

	ticker := time.NewTicker(time.Minute * 10)
	run := true

	for run {
		select {
		case <-ticker.C:
			s.checkForUpdates(ctx)
		case <-ctx.Done():
			run = false
		}
	}

	return ctx.Err()
}

func (s *GrafanaService) checkForUpdates(ctx context.Context) {
	var err error
	ctx, span := s.tracer.Start(ctx, "updatechecker.GrafanaService.checkForUpdates")
	defer span.End()

	traceID := tracing.TraceIDFromContext(ctx, false)
	traceIDLogOpts := []interface{}{"traceID", traceID}
	defer func() {
		if err != nil {
			span.RecordError(err)
			s.log.Debug("Update check failed", traceIDLogOpts...)
		} else {
			s.log.Debug("Update check succeeded", traceIDLogOpts...)
		}
	}()

	s.log.Debug("Checking for updates", traceIDLogOpts...)
	resp, err := s.httpClient.Get(ctx, "https://raw.githubusercontent.com/grafana/grafana/main/latest.json")
	if err != nil {
		s.log.Debug("Failed to get latest.json repo from github.com", "error", err)
		return
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			s.log.Warn("Failed to close response body", "err", err)
		}
	}()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		s.log.Debug("Update check failed, reading response from github.com", "error", err)
		return
	}

	type latestJSON struct {
		Stable  string `json:"stable"`
		Testing string `json:"testing"`
	}
	var latest latestJSON
	err = json.Unmarshal(body, &latest)
	if err != nil {
		s.log.Debug("Failed to unmarshal latest.json", "error", err)
		return
	}

	s.mutex.Lock()
	defer s.mutex.Unlock()
	if strings.Contains(s.grafanaVersion, "-") {
		s.latestVersion = latest.Testing
		s.hasUpdate = !strings.HasPrefix(s.grafanaVersion, latest.Testing)
	} else {
		s.latestVersion = latest.Stable
		s.hasUpdate = latest.Stable != s.grafanaVersion
	}

	currVersion, err1 := version.NewVersion(s.grafanaVersion)
	latestVersion, err2 := version.NewVersion(s.latestVersion)
	if err1 == nil && err2 == nil {
		s.hasUpdate = currVersion.LessThan(latestVersion)
	}
}

func (s *GrafanaService) UpdateAvailable() bool {
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	return s.hasUpdate
}

func (s *GrafanaService) LatestVersion() string {
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	return s.latestVersion
}
