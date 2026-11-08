// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"net/http"
	"net/url"
	"strings"
)

// Policy explicitly admits native asset-server origins. Web deployments leave
// AdditionalOrigins empty. This does not enable CORS or wildcard origins.
type Policy struct{ AdditionalOrigins []string }

func (p Policy) ValidOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || !strings.EqualFold(u.Host, r.Host) || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return false
	}
	if u.Scheme == "http" || u.Scheme == "https" {
		return true
	}
	for _, allowed := range p.AdditionalOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
}

// CheckWriteRequest is shared by source management and native capability APIs.
// Browser forms cannot send the required custom header; cross-site requests and
// opaque origins remain rejected even in a desktop WebView.
func CheckWriteRequest(w http.ResponseWriter, r *http.Request, policy Policy) bool {
	if r.Header.Get("X-Ecapture-UI") != "1" || r.Header.Get("Sec-Fetch-Site") == "cross-site" || !policy.ValidOrigin(r) {
		writeJSON(w, r, http.StatusForbidden, []byte(`{"error":"origin_rejected"}`))
		return false
	}
	return true
}
