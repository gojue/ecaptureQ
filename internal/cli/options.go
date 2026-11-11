// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Package cli owns the configuration shared by the two application entries.
package cli

import (
	"errors"
	"flag"
	"fmt"
	"strings"

	"github.com/gojue/ecaptureq/internal/app"
	"github.com/gojue/ecaptureq/internal/httpapi"
)

type Config struct {
	Options  app.Options
	Addr     string
	BasePath string
}

type endpointFlags []string

func (e *endpointFlags) String() string         { return strings.Join(*e, ",") }
func (e *endpointFlags) Set(value string) error { *e = append(*e, value); return nil }

func Parse(args []string, desktop bool) (Config, error) {
	c := Config{Options: app.DefaultOptions(), Addr: "127.0.0.1:28257", BasePath: "/"}
	flags := flag.NewFlagSet("eCaptureQ", flag.ContinueOnError)
	if !desktop {
		flags.StringVar(&c.Addr, "addr", c.Addr, "HTTP listen address")
	}
	flags.StringVar(&c.BasePath, "base-path", "/", "URL directory, e.g. /ecaptureq-web/")
	flags.StringVar(&c.Options.Mode, "mode", c.Options.Mode, "Initial UI mode: mock or live")
	flags.StringVar(&c.Options.ExcludeHTTPPathPrefix, "exclude-http-path-prefix", "", "Exclude captured HTTP path prefix and marked UI responses")
	var endpoints endpointFlags
	flags.Var(&endpoints, "ecaptureq", "eCapture WebSocket endpoint (repeat for multiple sources)")
	sourcesFile := flags.String("sources", "", "JSON config file (sources, page header and hidden domains); launch metadata is never executed")
	flags.IntVar(&c.Options.MaxRecords, "max-records", c.Options.MaxRecords, "Maximum retained live records")
	memoryMiB := flags.Int("max-memory-mib", c.Options.MaxBytes>>20, "Maximum retained record JSON in MiB (not process RSS)")
	frameMiB := flags.Int("max-frame-mib", c.Options.MaxFrameBytes>>20, "Maximum inbound WebSocket frame in MiB")
	if err := flags.Parse(args); err != nil {
		return c, err
	}
	if flags.NArg() != 0 {
		return c, fmt.Errorf("unexpected argument: %s", flags.Arg(0))
	}
	if *memoryMiB < 1 || *memoryMiB > 1024 || *frameMiB < 1 || *frameMiB > 64 {
		return c, errors.New("memory must be 1..1024 MiB and frame limit 1..64 MiB")
	}
	c.Options.MaxBytes, c.Options.MaxFrameBytes = *memoryMiB<<20, *frameMiB<<20
	c.Options.Endpoints = endpoints
	if *sourcesFile != "" {
		if err := app.LoadSources(*sourcesFile, &c.Options); err != nil {
			return c, err
		}
	}
	base, err := httpapi.NormalizeBasePath(c.BasePath)
	if err != nil {
		return c, err
	}
	c.BasePath = base
	return c, c.Options.Validate()
}
