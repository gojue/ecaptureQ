// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package app

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/gojue/ecaptureq/internal/auth"
)

// Config is the operator-supplied configuration file. It describes source
// connections, the page header, hidden-domain filter and optional Web auth. It is never
// executed and is not an attestation supplied by the eCaptureQ event protocol.
type Config struct {
	Auth          *auth.Config   `json:"auth,omitempty"`
	Sources       []SourceConfig `json:"sources,omitempty"`
	HeaderCenter  string         `json:"headerCenter,omitempty"`
	HiddenDomains []string       `json:"hiddenDomains,omitempty"`
}

// LoadSources reads the operator config file: source connections, the page
// header, hidden-domain filter and Web auth. Launch metadata is never executed.
func LoadSources(path string, options *Options) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open config: %w", err)
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, (128<<10)+1))
	if err != nil || len(data) > 128<<10 {
		return errors.New("config cannot exceed 128 KiB")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	var config *Config
	if err := decoder.Decode(&config); err != nil {
		return fmt.Errorf("decode config: %w", err)
	}
	if config == nil || decoder.Decode(new(any)) != io.EOF {
		return errors.New("config must contain one JSON object")
	}
	if len(config.Sources) > 16 {
		return errors.New("config must contain up to 16 sources")
	}
	if domains, err := normalizeHiddenDomains(config.HiddenDomains); err != nil {
		return err
	} else if len(domains) > 0 {
		options.HiddenDomains = domains
	}
	options.HeaderCenter = strings.TrimSpace(config.HeaderCenter)
	options.WebAuth = config.Auth
	for _, source := range config.Sources {
		options.Endpoints = append(options.Endpoints, source.Endpoint)
	}
	options.Sources = config.Sources
	options.SourcesFile, options.SourcesHash = path, sha256.Sum256(data)
	return nil
}

// normalizeHiddenDomains lower-cases each hidden domain and rejects values that
// cannot be a bare DNS suffix (e.g. ports, paths, userinfo or whitespace).
func normalizeHiddenDomains(domains []string) ([]string, error) {
	if len(domains) == 0 {
		return nil, nil
	}
	out := make([]string, 0, len(domains))
	for _, domain := range domains {
		domain = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(domain), "."))
		if domain == "" || strings.ContainsAny(domain, "/:@ \t\r\n") {
			return nil, errors.New("hiddenDomains contains an invalid domain")
		}
		out = append(out, domain)
	}
	return out, nil
}
