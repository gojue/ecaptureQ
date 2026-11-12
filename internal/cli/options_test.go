// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package cli

import (
	"errors"
	"flag"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestDefaultsAndPlatformFlags(t *testing.T) {
	c, err := Parse(nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != "127.0.0.1:28257" || c.Options.MaxRecords != 65536 || c.Options.MaxBytes != 192<<20 || c.BasePath != "/" {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	c, err = Parse([]string{"--listen", "127.0.0.1:1234"}, false)
	if err != nil || c.Addr != "127.0.0.1:1234" {
		t.Fatalf("Web listener flag failed: %+v %v", c, err)
	}
	for _, desktop := range []bool{false, true} {
		c, err = Parse([]string{"--data-source", "ws://localhost:9000", "--data-source", "wss://localhost:9001", "--base-path", "/ecaptureq-web"}, desktop)
		if err != nil || !slices.Equal(c.Options.Endpoints, []string{"ws://localhost:9000", "wss://localhost:9001"}) || c.BasePath != "/ecaptureq-web/" {
			t.Fatalf("shared flags failed (desktop=%t): %+v %v", desktop, c, err)
		}
	}
	if _, err := Parse([]string{"--listen", ":1234"}, true); err == nil {
		t.Fatal("desktop accepted listener flag")
	}
	if _, err := Parse([]string{"--help"}, false); !errors.Is(err, flag.ErrHelp) {
		t.Fatal("help did not return ErrHelp")
	}
}

func TestWebAuthConfigurationFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sources.json")
	for _, config := range []string{`null`, `{"auth":{}}`, `{"auth":{"username":"ecapture","passwordHash":"plaintext"}}`, `{"auth":{"username":"ecapture","password":"plaintext"}}`} {
		if err := os.WriteFile(path, []byte(config), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Parse([]string{"--sources", path}, false); err == nil {
			t.Fatal("Web accepted invalid authentication config")
		}
	}
	if err := os.WriteFile(path, []byte(`{"auth":{"username":"ecapture","passwordHash":"unused-by-desktop"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Parse([]string{"--sources", path}, true); err != nil {
		t.Fatal("Desktop must not enable or validate Web credentials:", err)
	}
	if _, err := Parse([]string{"--hash-password"}, true); err == nil {
		t.Fatal("Desktop accepted Web-only utility")
	}
	if c, err := Parse([]string{"--hash-password"}, false); err != nil || !c.HashPassword {
		t.Fatal("Web password utility flag")
	}
}

func TestInvalidConfiguration(t *testing.T) {
	for _, args := range [][]string{{"--max-memory-mib", "0"}, {"--max-memory-mib", "1025"}, {"--max-frame-mib", "65"}, {"--max-records", "0"}, {"--mode", "unknown"}, {"--data-source", "http://localhost"}, {"--addr", ":1234"}, {"--ecaptureq", "ws://localhost:9000"}, {"--base-path", "//evil.test/"}, {"unexpected"}} {
		if _, err := Parse(args, false); err == nil {
			t.Errorf("accepted %v", args)
		}
	}
}
