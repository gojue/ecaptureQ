// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"encoding/json"
	"github.com/gojue/ecaptureq/frontend"
	"github.com/gojue/ecaptureq/internal/app"
	"github.com/gojue/ecaptureq/internal/version"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceManifestProvenance(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sources.json")
	manifest := `[{"endpoint":"ws://127.0.0.1:28257/","label":"GoTLS validation","capture":{"host":"capture-host","module":"gotls","mode":"text","textSource":"pcapng","command":"sudo ./ecapture gotls --model text --text-source pcapng 'tcp port 8443'","collectorCommit":"test-commit","decryptorVersion":"v1.4.1"}}]`
	if err := os.WriteFile(path, []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	opts := app.DefaultOptions()
	opts.Mode = "live"
	if err := app.LoadSources(path, &opts); err != nil {
		t.Fatal(err)
	}
	store, err := app.NewStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := New(opts, store, frontend.Files, Policy{})
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"/api/status", "/api/workspace?mode=live"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, route, nil))
		for _, expected := range []string{"capture-host", "test-commit", "v1.4.1", "--text-source pcapng"} {
			if !strings.Contains(w.Body.String(), expected) {
				t.Errorf("%s omitted provenance %q", route, expected)
			}
		}
	}
	for name, input := range map[string]string{
		"null": `null`, "trailing": manifest + `{}`, "unknown": `[{"endpoint":"ws://localhost/","typo":true}]`,
		"oversized": strings.Repeat(" ", 128<<10) + manifest,
	} {
		t.Run(name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(input), 0600); err != nil {
				t.Fatal(err)
			}
			if err := app.LoadSources(path, &opts); err == nil {
				t.Fatal("invalid manifest accepted")
			}
		})
	}
}

func TestWorkspaceAndStaticEntry(t *testing.T) {
	handler, err := newHandler()
	if err != nil {
		t.Fatal(err)
	}
	workspace := httptest.NewRecorder()
	handler.ServeHTTP(workspace, httptest.NewRequest(http.MethodGet, "/api/workspace", nil))
	if workspace.Code != http.StatusOK || !json.Valid(workspace.Body.Bytes()) {
		t.Fatalf("workspace returned status %d or invalid JSON", workspace.Code)
	}
	if workspace.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("workspace responses must not be cached")
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(workspace.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"session", "processes", "requests"} {
		if _, ok := data[field]; !ok {
			t.Errorf("workspace is missing %q", field)
		}
	}
	page := httptest.NewRecorder()
	handler.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/", nil))
	if page.Code != http.StatusOK || !strings.Contains(strings.ToLower(page.Body.String()), "<!doctype html>") {
		t.Fatalf("static entry returned status %d or did not serve HTML", page.Code)
	}
	if page.Header().Get("Cache-Control") != "no-cache" {
		t.Fatal("static resources must revalidate during prototype development")
	}
}

func TestReadOnlyRoutes(t *testing.T) {
	handler, err := newHandler()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/workspace", "/api/health", "/api/version", "/"} {
		t.Run("POST "+path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, nil))
			if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, HEAD" {
				t.Fatalf("expected read-only route, got status %d and Allow %q", response.Code, response.Header().Get("Allow"))
			}
		})
		t.Run("HEAD "+path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodHead, path, nil))
			if response.Code != http.StatusOK || response.Body.Len() != 0 {
				t.Fatalf("HEAD returned status %d and %d body bytes", response.Code, response.Body.Len())
			}
		})
	}
	for _, path := range []string{"/api", "/api/missing"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound || !json.Valid(response.Body.Bytes()) {
			t.Errorf("unknown API %q returned status %d or non-JSON body", path, response.Code)
		}
	}
}

func TestSourceCreationAPI(t *testing.T) {
	opts := app.DefaultOptions()
	opts.Mode = "live" // An empty live workspace can be configured from the UI.
	store, err := app.NewStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := New(opts, store, frontend.Files, Policy{})
	if err != nil {
		t.Fatal(err)
	}
	post := func(body, origin, contentType, header string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "http://localhost:5173/api/sources", strings.NewReader(body))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", contentType)
		r.Header.Set("X-Ecapture-UI", header)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	valid := `{"endpoint":"ws://LOCALHOST:28257","label":"GoTLS 开发环境","capture":{"module":"gotls","mode":"text","textSource":"pcapng"}}`
	for _, tc := range []struct {
		name, body, origin, contentType, header string
		status                                  int
	}{
		{"cross origin", valid, "https://untrusted.test", "application/json", "1", 403},
		{"missing header", valid, "http://localhost:5173", "application/json", "", 403},
		{"form body", valid, "http://localhost:5173", "text/plain", "1", 415},
		{"trailing data", valid + `{}`, "http://localhost:5173", "application/json", "1", 400},
		{"unknown field", `{"endpoint":"ws://localhost/","unknown":true}`, "http://localhost:5173", "application/json", "1", 400},
		{"oversized", strings.Repeat(" ", 128<<10) + valid, "http://localhost:5173", "application/json", "1", 400},
		{"invalid scheme", `{"endpoint":"file:///etc/hosts"}`, "http://localhost:5173", "application/json", "1", 400},
		{"credentials", `{"endpoint":"ws://user:secret@localhost/"}`, "http://localhost:5173", "application/json", "1", 400},
		{"success", valid, "http://localhost:5173", "application/json", "1", 201},
		{"canonical duplicate", `{"endpoint":"ws://localhost:28257/"}`, "http://localhost:5173", "application/json", "1", 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := post(tc.body, tc.origin, tc.contentType, tc.header)
			if w.Code != tc.status || !json.Valid(w.Body.Bytes()) {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			if w.Header().Get("Content-Type") != "application/json; charset=utf-8" {
				t.Fatal("missing JSON content type")
			}
		})
	}
	if status := store.Status(); len(status.Sources) != 1 || status.Sources[0].Endpoint != "ws://localhost:28257/" {
		t.Fatalf("unexpected sources: %+v", status.Sources)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if !strings.Contains(w.Body.String(), `"liveConfigured":true`) {
		t.Fatal("health ignored dynamically added source")
	}
}

func TestSourcePersistenceAndConflictingEdits(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sources.json")
	initial := `[{"endpoint":"ws://localhost:28257/","label":"first"}]`
	if err := os.WriteFile(path, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	opts := app.DefaultOptions()
	if err := app.LoadSources(path, &opts); err != nil {
		t.Fatal(err)
	}
	store, err := app.NewStore(opts)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.AddSource(app.SourceConfig{Endpoint: "ws://localhost:28258/", Label: "second"}); err != nil {
		t.Fatal(err)
	}
	reloaded := app.DefaultOptions()
	if err = app.LoadSources(path, &reloaded); err != nil {
		t.Fatal(err)
	}
	if len(reloaded.Sources) != 2 {
		t.Fatal("new source did not survive reload")
	}
	if err = os.WriteFile(path, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = store.AddSource(app.SourceConfig{Endpoint: "ws://localhost:28259/"}); err == nil || err.Error() != "source_config_changed" {
		t.Fatalf("external edit was not protected: %v", err)
	}
	if len(store.Status().Sources) != 2 {
		t.Fatal("failed persistence still added a source")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != initial {
		t.Fatal("external edit overwritten")
	}
}

func TestVersionRoute(t *testing.T) {
	handler, err := newHandler()
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/version", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("/api/version returned status %d", response.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("/api/version returned invalid JSON: %v", err)
	}
	if body["version"] != version.Version {
		t.Fatalf("reported version %q, want %q", body["version"], version.Version)
	}
}

func newHandler() (http.Handler, error) {
	options := app.DefaultOptions()
	store, err := app.NewStore(options)
	if err != nil {
		return nil, err
	}
	return New(options, store, frontend.Files, Policy{})
}
