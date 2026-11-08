// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"
	"time"

	pb "github.com/gojue/ecapture/v2/protobuf/gen/v1"
	"github.com/gojue/ecaptureQ/frontend"
	"github.com/gojue/ecaptureQ/internal/app"
	"golang.org/x/net/websocket"
	"google.golang.org/protobuf/proto"
)

func TestLiveAndMockHTTPIsolationAndPagedDetails(t *testing.T) {
	source := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		for i := 0; i < 451; i++ {
			body := "captured payload"
			if i == 1 {
				body = "DeepBodyToken"
			}
			payload := fmt.Sprintf("POST /item/%d HTTP/1.1\r\nHost: example.test\r\nContent-Length: %d\r\n\r\n%s", i, len(body), body)
			event := &pb.Event{Uuid: fmt.Sprintf("connection-%d", i), Pid: 42, Pname: "fixture", Payload: []byte(payload), CaptureFormat: pb.CaptureFormat_CAPTURE_FORMAT_TEXT}
			entry := &pb.LogEntry{LogType: pb.LogType_LOG_TYPE_EVENT, Payload: &pb.LogEntry_EventPayload{EventPayload: event}}
			data, err := proto.Marshal(entry)
			if err != nil {
				t.Error(err)
				return
			}
			if err = websocket.Message.Send(conn, data); err != nil {
				return
			}
		}
		var data []byte
		_ = websocket.Message.Receive(conn, &data)
	}))
	defer source.Close()
	opts := app.DefaultOptions()
	opts.Mode = "live"
	opts.MaxRecords = 450
	opts.Endpoints = []string{"ws" + strings.TrimPrefix(source.URL, "http")}
	service, err := app.New(opts)
	if err != nil {
		t.Fatal(err)
	}
	service.Start(context.Background())
	defer service.Close()
	deadline := time.Now().Add(3 * time.Second)
	for status := service.Store().Status(); status.Events != 451 || status.Evicted != 1; status = service.Store().Status() {
		if time.Now().After(deadline) {
			t.Fatal("synthetic events not received")
		}
		time.Sleep(time.Millisecond)
	}
	handler, err := New(opts, service.Store(), frontend.Files, Policy{})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path, mode string
		count      int
	}{
		{"/api/workspace", "live", 450},
		{"/api/workspace?mode=live&view=page", "live", 200},
		{"/api/workspace?mode=live&view=page&page=2", "live", 50},
		{"/api/workspace?mode=live&view=page&q=DeepBodyToken", "live", 1},
		{"/api/workspace?mode=mock", "mock", 60},
	} {
		t.Run(tc.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
			var body struct {
				Mode     string           `json:"mode"`
				Requests []map[string]any `json:"requests"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || body.Mode != tc.mode || len(body.Requests) != tc.count {
				t.Fatalf("status=%d mode=%s count=%d", w.Code, body.Mode, len(body.Requests))
			}
			if strings.Contains(tc.path, "view=page") {
				for _, row := range body.Requests {
					if row["request"] != nil || row["response"] != nil {
						t.Fatal("page included full payload")
					}
				}
			}
		})
	}
	for _, tc := range []struct {
		path   string
		status int
	}{
		{"/api/workspace?mode=live&view=page&page=-1", 400},
		{"/api/workspace?mode=other", 400},
		{"/api/record?id=source-1-1-2", 200},
		{"/api/record?id=source-1-1-1", 404},
	} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if w.Code != tc.status || !json.Valid(w.Body.Bytes()) || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("unexpected response for %s: %d", tc.path, w.Code)
		}
	}
	for _, route := range []string{"/api/status", "/api/health", "/api/workspace?mode=live&view=page"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodHead, route, nil))
		if w.Code != 200 || w.Body.Len() != 0 {
			t.Fatalf("HEAD failed for %s", route)
		}
	}
}

func TestBasePathAssetsAPIsAndRedirects(t *testing.T) {
	for _, base := range []string{"/", "/ecaptureq-web/"} {
		t.Run(base, func(t *testing.T) {
			handler, err := newHandler()
			if err != nil {
				t.Fatal(err)
			}
			handler, err = Mount(base, handler)
			if err != nil {
				t.Fatal(err)
			}
			for _, asset := range []string{"", "index.html", "app.js", "http-body.js", "platform.js", "styles.css", "protocol-viewers.js", "ecapture-logo.svg", "api/health", "api/workspace?mode=mock"} {
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, base+asset, nil))
				if asset == "index.html" {
					if w.Code != 301 || w.Header().Get("Location") != "./" {
						t.Fatalf("unsafe index redirect: %d %s", w.Code, w.Header().Get("Location"))
					}
					continue
				}
				if w.Code != 200 {
					t.Errorf("%s returned %d", base+asset, w.Code)
				}
			}
			if base != "/" {
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, strings.TrimSuffix(base, "/")+"?mode=mock", nil))
				if w.Code != 308 || w.Header().Get("Location") != base+"?mode=mock" {
					t.Fatal("prefix redirect lost directory/query")
				}
				w = httptest.NewRecorder()
				handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/health", nil))
				if w.Code != 404 {
					t.Fatal("root API unexpectedly exposed")
				}
			}
			request := httptest.NewRequest(http.MethodPost, base+"api/sources", strings.NewReader(`{"endpoint":"ws://localhost:9000"}`))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Ecapture-UI", "1")
			request.Header.Set("Origin", "http://example.com")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, request)
			if w.Code != 201 {
				t.Fatalf("mounted source API failed: %d %s", w.Code, w.Body.String())
			}
		})
	}
	for _, invalid := range []string{"https://example.test/", "//example.test/", "/a/../b/", "/a//b/", "/%61/", "/a?x=1", "/a#fragment", "/a\\b"} {
		if _, err := NormalizeBasePath(invalid); err == nil {
			t.Errorf("accepted unsafe base path %q", invalid)
		}
	}
}

func TestNativeOriginIsExplicitAndHostBound(t *testing.T) {
	for _, tc := range []struct {
		name, origin, host, site string
		native, want             bool
	}{
		{"web", "http://localhost", "localhost", "same-origin", false, true},
		{"mac allowed", "wails://localhost", "localhost", "same-origin", true, true},
		{"mac web rejected", "wails://localhost", "localhost", "same-origin", false, false},
		{"windows", "http://wails.localhost", "wails.localhost", "same-origin", true, true},
		{"unlisted", "wails://elsewhere", "elsewhere", "same-origin", true, false},
		{"wrong host", "wails://localhost", "attacker.test", "same-origin", true, false},
		{"opaque", "null", "localhost", "same-origin", true, false},
		{"path", "http://localhost/", "localhost", "same-origin", true, false},
		{"cross site", "wails://localhost", "localhost", "cross-site", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy := Policy{}
			if tc.native {
				policy.AdditionalOrigins = []string{"wails://localhost"}
			}
			r := httptest.NewRequest(http.MethodPost, "http://"+tc.host+"/api/sources", nil)
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("X-Ecapture-UI", "1")
			r.Header.Set("Sec-Fetch-Site", tc.site)
			w := httptest.NewRecorder()
			if got := CheckWriteRequest(w, r, policy); got != tc.want {
				t.Errorf("allowed=%v want=%v", got, tc.want)
			}
			if w.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatal("CORS unexpectedly enabled")
			}
		})
	}
}

func TestReverseProxyPreservesPrefixHostAndOriginPolicy(t *testing.T) {
	const publicHost = "analysis.example.test:8443"
	const publicOrigin = "https://" + publicHost
	for _, base := range []string{"/", "/ecaptureq-web/"} {
		t.Run(base, func(t *testing.T) {
			handler, err := newHandler()
			if err != nil {
				t.Fatal(err)
			}
			handler, err = Mount(base, handler)
			if err != nil {
				t.Fatal(err)
			}
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Host != publicHost {
					t.Errorf("proxy lost external Host: %q", r.Host)
				}
				if base != "/" && !strings.HasPrefix(r.URL.Path, strings.TrimSuffix(base, "/")) {
					t.Errorf("proxy stripped configured prefix: %q", r.URL.Path)
				}
				handler.ServeHTTP(w, r)
			}))
			defer backend.Close()
			target, err := url.Parse(backend.URL)
			if err != nil {
				t.Fatal(err)
			}
			proxy := httptest.NewServer(&httputil.ReverseProxy{Rewrite: func(r *httputil.ProxyRequest) {
				r.SetURL(target)       // Preserve the complete incoming path and query.
				r.Out.Host = r.In.Host // Equivalent to proxy_set_header Host $http_host.
				r.SetXForwarded()
				r.Out.Header.Set("X-Forwarded-Proto", "https")
			}})
			defer proxy.Close()
			client := proxy.Client()
			client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
			request := func(method, route, origin, body string) (*http.Response, string) {
				t.Helper()
				req, err := http.NewRequest(method, proxy.URL+route, strings.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				req.Host = publicHost
				if method == http.MethodPost {
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set("X-Ecapture-UI", "1")
					req.Header.Set("Origin", origin)
				}
				response, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				data, err := io.ReadAll(response.Body)
				_ = response.Body.Close()
				if err != nil {
					t.Fatal(err)
				}
				return response, string(data)
			}
			for _, route := range []string{"", "app.js", "styles.css", "ecapture-logo.svg", "api/health", "api/workspace?mode=mock"} {
				response, body := request(http.MethodGet, base+route, "", "")
				if response.StatusCode != http.StatusOK || body == "" {
					t.Fatalf("proxied %s: status=%d", route, response.StatusCode)
				}
				if route == "" && !strings.Contains(strings.ToLower(body), "<!doctype html>") {
					t.Fatal("proxy did not serve index HTML")
				}
				if strings.HasPrefix(route, "api/") && !json.Valid([]byte(body)) {
					t.Fatal("proxy API returned non-JSON")
				}
			}
			response, _ := request(http.MethodGet, base+"index.html", "", "")
			if response.StatusCode != http.StatusMovedPermanently || response.Header.Get("Location") != "./" {
				t.Fatal("proxied index redirect escaped prefix")
			}
			if base != "/" {
				response, _ = request(http.MethodGet, strings.TrimSuffix(base, "/")+"?mode=mock", "", "")
				if response.StatusCode != http.StatusPermanentRedirect || response.Header.Get("Location") != base+"?mode=mock" {
					t.Fatal("proxied directory redirect lost prefix or query")
				}
			}
			response, body := request(http.MethodPost, base+"api/sources", publicOrigin, `{"endpoint":"ws://localhost:9000","label":"synthetic proxy fixture"}`)
			if response.StatusCode != http.StatusCreated {
				t.Fatalf("same-origin management through proxy failed: %d %s", response.StatusCode, body)
			}
			response, body = request(http.MethodPost, base+"api/sources", "https://attacker.invalid", `{"endpoint":"ws://localhost:9001"}`)
			if response.StatusCode != http.StatusForbidden || !strings.Contains(body, "origin_rejected") {
				t.Fatalf("malicious proxy origin accepted: %d %s", response.StatusCode, body)
			}
			if response.Header.Get("Access-Control-Allow-Origin") != "" {
				t.Fatal("proxy endpoint enabled CORS")
			}
			response, body = request(http.MethodGet, base+"api/sources", "", "")
			var status struct {
				Sources []json.RawMessage `json:"sources"`
			}
			if response.StatusCode != http.StatusOK || json.Unmarshal([]byte(body), &status) != nil || len(status.Sources) != 1 {
				t.Fatal("rejected request mutated sources")
			}
		})
	}
}
