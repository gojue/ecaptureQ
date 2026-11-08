// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package cli

import (
	"errors"
	"flag"
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
	c, err = Parse([]string{"--ecaptureq", "ws://localhost:9000", "--ecaptureq", "ws://localhost:9001", "--base-path", "/ecaptureq-web"}, true)
	if err != nil || len(c.Options.Endpoints) != 2 || c.BasePath != "/ecaptureq-web/" {
		t.Fatalf("shared flags failed: %+v %v", c, err)
	}
	if _, err := Parse([]string{"--addr", ":1234"}, true); err == nil {
		t.Fatal("desktop accepted listener flag")
	}
	if _, err := Parse([]string{"--help"}, false); !errors.Is(err, flag.ErrHelp) {
		t.Fatal("help did not return ErrHelp")
	}
}

func TestInvalidConfiguration(t *testing.T) {
	for _, args := range [][]string{{"--max-memory-mib", "0"}, {"--max-memory-mib", "1025"}, {"--max-frame-mib", "65"}, {"--max-records", "0"}, {"--mode", "unknown"}, {"--ecaptureq", "http://localhost"}, {"--base-path", "//evil.test/"}, {"unexpected"}} {
		if _, err := Parse(args, false); err == nil {
			t.Errorf("accepted %v", args)
		}
	}
}
