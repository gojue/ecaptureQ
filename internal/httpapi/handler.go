// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Package httpapi serves the same UI and API in browsers and desktop WebViews.
package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"strings"

	"github.com/gojue/ecaptureq/internal/app"
	"github.com/gojue/ecaptureq/internal/version"
)

func New(options app.Options, live *app.Store, staticFiles fs.FS, policy Policy) (http.Handler, error) {
	workspace, err := fs.ReadFile(staticFiles, "mock-data.json")
	if err != nil {
		return nil, err
	}
	var mock map[string]any
	if err := json.Unmarshal(workspace, &mock); err != nil {
		return nil, fmt.Errorf("embedded mock workspace: %w", err)
	}
	staticHandler := http.FileServer(http.FS(staticFiles))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Ecaptureq-UI", "1")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-cache")
		if r.URL.Path == "/api/decode-body" && r.Method == http.MethodPost {
			if CheckWriteRequest(w, r, policy) {
				decodeBody(w, r)
			}
			return
		}
		if r.URL.Path == "/api/sources" && r.Method == http.MethodPost {
			addSource(w, r, live, policy)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			if r.URL.Path == "/api/sources" || r.URL.Path == "/api/decode-body" {
				w.Header().Set("Allow", "GET, HEAD, POST")
			}
			writeJSON(w, r, http.StatusMethodNotAllowed, []byte(`{"error":"method_not_allowed"}`))
			return
		}
		switch r.URL.Path {
		case "/api/workspace":
			mode := r.URL.Query().Get("mode")
			if mode == "" {
				mode = options.Mode
			}
			if mode != "mock" && mode != "live" {
				writeJSON(w, r, http.StatusBadRequest, []byte(`{"error":"invalid_mode"}`))
				return
			}
			if mode == "live" {
				if r.URL.Query().Get("view") == "page" {
					page, err := live.WorkspacePage(r.URL.Query())
					if err != nil {
						writeJSON(w, r, http.StatusBadRequest, []byte(`{"error":"invalid_query"}`))
						return
					}
					writeValue(w, r, page)
					return
				}
				writeValue(w, r, live.Workspace())
				return
			}
			result := make(map[string]any, len(mock)+3)
			for key, value := range mock {
				result[key] = value
			}
			result["mode"] = "mock"
			result["revision"] = 0
			result["status"] = live.Status()
			writeValue(w, r, result)
		case "/api/record":
			if record, ok := live.Record(r.URL.Query().Get("id")); ok {
				writeJSON(w, r, http.StatusOK, record)
			} else {
				writeJSON(w, r, http.StatusNotFound, []byte(`{"error":"record_evicted"}`))
			}
		case "/api/status":
			writeValue(w, r, live.Status())
		case "/api/sources":
			writeValue(w, r, live.Status())
		case "/api/version":
			writeValue(w, r, map[string]string{"version": version.Version})
		case "/api/config":
			writeValue(w, r, map[string]any{"headerCenter": options.HeaderCenter})
		case "/api/health":
			status := live.Status()
			writeValue(w, r, map[string]any{"status": "ok", "mode": options.Mode, "liveConfigured": len(status.Sources) > 0, "availableModes": []string{"mock", "live"}, "connection": status.State})
		default:
			if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
				writeJSON(w, r, http.StatusNotFound, []byte(`{"error":"not_found"}`))
				return
			}
			staticHandler.ServeHTTP(w, r)
		}
	}), nil
}

func addSource(w http.ResponseWriter, r *http.Request, live *app.Store, policy Policy) {
	if !CheckWriteRequest(w, r, policy) {
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeJSON(w, r, http.StatusUnsupportedMediaType, []byte(`{"error":"json_required"}`))
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
	decoder.DisallowUnknownFields()
	var config app.SourceConfig
	if decoder.Decode(&config) != nil || decoder.Decode(new(any)) != io.EOF {
		writeJSON(w, r, http.StatusBadRequest, []byte(`{"error":"invalid_source"}`))
		return
	}
	source, err := live.AddSource(config)
	if err != nil {
		code := err.Error()
		status := http.StatusBadRequest
		switch code {
		case "duplicate_source", "source_limit", "source_config_changed":
			status = http.StatusConflict
		case "source_save_failed":
			status = http.StatusInternalServerError
		case "service_stopping":
			status = http.StatusServiceUnavailable
		}
		body, _ := json.Marshal(map[string]string{"error": code})
		writeJSON(w, r, status, body)
		return
	}
	body, err := json.Marshal(map[string]any{"source": source, "status": live.Status()})
	if err != nil {
		writeJSON(w, r, http.StatusInternalServerError, []byte(`{"error":"encoding_failed"}`))
		return
	}
	writeJSON(w, r, http.StatusCreated, body)
}

func writeValue(w http.ResponseWriter, r *http.Request, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		writeJSON(w, r, http.StatusInternalServerError, []byte(`{"error":"encoding_failed"}`))
		return
	}
	writeJSON(w, r, http.StatusOK, body)
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}
