// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"errors"
	"net/http"
	"path"
	"strings"
)

// NormalizeBasePath accepts one absolute URL directory, never a URL or escaped
// path. Relative frontend URLs then work both directly and through a proxy.
func NormalizeBasePath(base string) (string, error) {
	if base == "" {
		return "/", nil
	}
	if !strings.HasPrefix(base, "/") || strings.HasPrefix(base, "//") || strings.ContainsAny(base, "?#%\\\r\n") || path.Clean(base) != strings.TrimSuffix(base, "/") && base != "/" {
		return "", errors.New("base-path must be a clean absolute URL directory")
	}
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	return base, nil
}

// Mount serves only the configured prefix and preserves queries on the
// trailing-slash redirect. It also supports proxies that retain the prefix.
func Mount(base string, handler http.Handler) (http.Handler, error) {
	base, err := NormalizeBasePath(base)
	if err != nil {
		return nil, err
	}
	if base == "/" {
		return handler, nil
	}
	bare := strings.TrimSuffix(base, "/")
	stripped := http.StripPrefix(bare, handler)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == bare {
			target := base
			if r.URL.RawQuery != "" {
				target += "?" + r.URL.RawQuery
			}
			http.Redirect(w, r, target, http.StatusPermanentRedirect)
			return
		}
		if !strings.HasPrefix(r.URL.Path, base) {
			http.NotFound(w, r)
			return
		}
		stripped.ServeHTTP(w, r)
	}), nil
}
