//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func hideWindow(cmd *exec.Cmd) {}

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
