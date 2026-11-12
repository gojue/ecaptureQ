// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/gojue/ecaptureq/internal/auth"
	"golang.org/x/term"
)

func hashPassword() error {
	var password []byte
	var err error
	if term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Fprint(os.Stderr, "Password: ")
		password, err = term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return err
		}
		fmt.Fprint(os.Stderr, "Confirm password: ")
		confirm, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return err
		}
		if string(password) != string(confirm) {
			return errors.New("passwords do not match")
		}
	} else {
		password, err = io.ReadAll(io.LimitReader(os.Stdin, 1027))
		if err != nil {
			return err
		}
		password = []byte(strings.TrimSuffix(strings.TrimSuffix(string(password), "\n"), "\r"))
	}
	hash, err := auth.HashPassword(string(password))
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, hash)
	return nil
}
