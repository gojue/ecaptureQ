// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package app

import (
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"
)

// CollectorInfo is the presentation snapshot of eCapture's collector_info
// operational log. It is never executed or persisted as source configuration.
type CollectorInfo struct {
	Host             string   `json:"host,omitempty"`
	Module           string   `json:"module,omitempty"`
	Mode             string   `json:"mode,omitempty"`
	TextSource       string   `json:"textSource,omitempty"`
	Argv             []string `json:"argv,omitempty"`
	ArgvTruncated    bool     `json:"argvTruncated,omitempty"`
	Version          string   `json:"version,omitempty"`
	BuildTime        string   `json:"buildTime,omitempty"`
	DecryptorVersion string   `json:"decryptorVersion,omitempty"`
	Commit           string   `json:"commit,omitempty"`
	ConfigListen     string   `json:"configListen,omitempty"`
	StreamListen     string   `json:"streamListen,omitempty"`
	Outputs          []string `json:"outputs,omitempty"`
	OutputsTruncated bool     `json:"outputsTruncated,omitempty"`
}

func (c *CollectorInfo) clone() *CollectorInfo {
	if c == nil {
		return nil
	}
	copy := *c
	copy.Argv = append([]string(nil), c.Argv...)
	copy.Outputs = append([]string(nil), c.Outputs...)
	return &copy
}

// The marker belongs to upstream's structured PROCESS_LOG payload; it does not
// add another wire protocol. Unrecognized logs retain their existing behavior.
func parseCollectorInfo(message string) (*CollectorInfo, bool) {
	var marker struct {
		Event string `json:"event"`
	}
	if json.Unmarshal([]byte(message), &marker) != nil || marker.Event != "collector_info" {
		return nil, false
	}
	if len(message) > 256<<10 || !utf8.ValidString(message) {
		return nil, true
	}
	var entry struct {
		SchemaVersion int            `json:"schemaVersion"`
		Collector     *CollectorInfo `json:"collector"`
	}
	if json.Unmarshal([]byte(message), &entry) != nil || entry.SchemaVersion != 1 || entry.Collector == nil {
		return nil, true
	}
	c := entry.Collector
	valid := func(value string, limit int) bool {
		return len(value) <= limit && utf8.ValidString(value) && !strings.ContainsRune(value, '\x00')
	}
	for _, field := range []struct {
		value string
		limit int
	}{
		{c.Host, 256}, {c.Module, 64}, {c.Mode, 64}, {c.TextSource, 64},
		{c.Version, 512}, {c.BuildTime, 64}, {c.DecryptorVersion, 512},
		{c.Commit, 128}, {c.ConfigListen, 2048}, {c.StreamListen, 2048},
	} {
		if !valid(field.value, field.limit) {
			return nil, true
		}
	}
	if c.BuildTime != "" {
		if _, err := time.Parse(time.RFC3339Nano, c.BuildTime); err != nil || !strings.HasSuffix(c.BuildTime, "Z") {
			return nil, true
		}
	}
	for _, list := range []struct {
		values []string
		limit  int
	}{{c.Argv, 256}, {c.Outputs, 64}} {
		if len(list.values) > list.limit {
			return nil, true
		}
		size := 0
		for _, value := range list.values {
			size += len(value)
			if size > 8192 || !valid(value, 8192) {
				return nil, true
			}
		}
	}
	return c, true
}
