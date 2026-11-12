// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package app

import "strings"

// defaultHiddenDomains are host suffixes whose captured traffic is discarded
// before storage, so matching requests and responses are never rendered in the
// UI. Operators can replace the list with hiddenDomains in the --sources file.
var defaultHiddenDomains = []string{
	"github.com",
	"githubusercontent.com",
	"githubapp.com",
	"githubassets.com",
	"github.io",
	"github.dev",
	"githubpreview.dev",
	"githubcopilot.com",
	"githubstatus.com",
	"github.blog",
	"github.net",
	"ghcr.io",
}

// isHiddenHost reports whether host (a Host header or authority value, which may
// include a port) matches one of the configured hidden domains. Matching is
// case-insensitive and treats the apex and any subdomain equally.
func isHiddenHost(host string, domains []string) bool {
	host = strings.TrimSpace(host)
	if host == "" {
		return false
	}
	// Strip a single trailing :port, but leave IPv6 literals intact.
	if i := strings.LastIndexByte(host, ':'); i > 0 && !strings.Contains(host[:i], ":") {
		host = host[:i]
	}
	// Bracketed IPv6 literals never match a DNS suffix.
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return false
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, domain := range domains {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}
	return false
}
