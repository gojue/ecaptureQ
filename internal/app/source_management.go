// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package app

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"unicode/utf8"
)

type sourceRun struct {
	cancel context.CancelFunc
	done   chan struct{}
}

func normalizeSource(config SourceConfig) (SourceConfig, error) {
	endpoint, err := normalizeEndpoint(config.Endpoint)
	if err != nil {
		return config, err
	}
	config.Endpoint = endpoint
	config.Label = strings.TrimSpace(config.Label)
	if utf8.RuneCountInString(config.Label) > 160 {
		return config, errors.New("invalid_label")
	}
	if config.Label == "" {
		u, _ := url.Parse(endpoint)
		config.Label = u.Host
	}
	if config.Capture != nil {
		c := *config.Capture
		config.Capture = &c
	}
	return config, nil
}

func (s *Store) activeSourceCountLocked() int {
	count := 0
	for _, source := range s.sources {
		if source.ID != "" {
			count++
		}
	}
	return count
}

// ManageSource stops and joins the old connector before reusing its slot. IDs
// are never reused, and reconnects retain their generation counter and files.
func (s *Store) ManageSource(id, action string, config SourceConfig) (SourceStatus, error) {
	if action != "edit" && action != "reconnect" && action != "remove" {
		return SourceStatus{}, errors.New("invalid_source")
	}
	if action == "edit" {
		var err error
		config, err = normalizeSource(config)
		if err != nil {
			return SourceStatus{}, err
		}
	}
	s.sourceMu.Lock()
	defer s.sourceMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing || (s.ctx != nil && s.ctx.Err() != nil) {
		return SourceStatus{}, errors.New("service_stopping")
	}
	index := -1
	for i, source := range s.sources {
		if source.ID != "" && source.ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		return SourceStatus{}, errors.New("source_not_found")
	}
	old := s.sources[index]
	if action == "edit" {
		for i, source := range s.sources {
			if i != index && source.ID != "" && source.Endpoint == config.Endpoint {
				return SourceStatus{}, errors.New("duplicate_source")
			}
		}
	}
	if action != "reconnect" && old.Persistent {
		configs := make([]SourceConfig, 0, len(s.options.Sources)+1)
		for _, saved := range s.options.Sources {
			endpoint, _ := normalizeEndpoint(saved.Endpoint)
			if endpoint != old.Endpoint {
				configs = append(configs, saved)
			}
		}
		if action == "edit" {
			configs = append(configs, config)
		}
		if err := s.persistSourcesLocked(configs); err != nil {
			return SourceStatus{}, err
		}
	}
	// Renaming alone must not interrupt capture or split a native file.
	restart := action != "edit" || config.Endpoint != old.Endpoint
	if restart {
		run := s.sourceRuns[index]
		if run.cancel != nil {
			run.cancel()
			s.mu.Unlock()
			<-run.done
			s.mu.Lock()
		}
		s.sourceRuns[index] = sourceRun{}
	}
	if action == "remove" {
		s.sources[index] = SourceStatus{}
		s.notifyLocked()
		return old, nil
	}
	source := &s.sources[index]
	if action == "edit" {
		source.Label, source.Endpoint, source.Capture = config.Label, config.Endpoint, config.Capture
	}
	if restart {
		source.State, source.LastError, source.LastHeartbeat = "connecting", "", ""
		source.Collector = nil
		if s.ctx != nil {
			s.startSourceLocked(index)
		}
	}
	s.notifyLocked()
	return *source, nil
}
