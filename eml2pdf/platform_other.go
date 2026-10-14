//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// Nicht-Windows-Variante: dient zum Testen auf Linux/macOS.

func hideWindow(cmd *exec.Cmd) {}

func showInfo(title, text string)    { fmt.Printf("[%s]\n%s\n", title, text) }
func showWarning(title, text string) { fmt.Printf("[%s – Warnung]\n%s\n", title, text) }

func lockFile(name string, flags int) (*os.File, bool) {
	f, err := os.OpenFile(filepath.Join(dataDir, name), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, false
	}
	if syscall.Flock(int(f.Fd()), flags) != nil {
		f.Close()
		return nil, false
	}
	return f, true
}

func acquireWorkerLock() func() {
	f, ok := lockFile("umwandlung.lock", syscall.LOCK_EX)
	if !ok {
		return func() {}
	}
	return func() { f.Close() }
}

var watcherLock *os.File

func tryWatcherLock() bool {
	f, ok := lockFile("ueberwachung.lock", syscall.LOCK_EX|syscall.LOCK_NB)
	watcherLock = f
	return ok
}

func downloadsFolder() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Downloads")
}

func isInstalledCopy() bool                            { return true }
func askYesNo(title, text string) bool                 { showInfo(title, text); return false }
func chooseFolder(prompt, start string) (string, bool) { return start, false }
func installApp()                                      { fmt.Println("Installation gibt es nur unter Windows.") }
func uninstallApp()                                    { installApp() }
