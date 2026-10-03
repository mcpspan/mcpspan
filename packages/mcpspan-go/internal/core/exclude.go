package core

import "sync"

var (
	excludedMu sync.RWMutex
	excluded   = map[string]bool{}
)

// Exclude leaves a tool, by the name it is registered under, out of the
// numbers entirely, refused calls to it included.
func Exclude(name string) {
	excludedMu.Lock()
	excluded[name] = true
	excludedMu.Unlock()
}

// Excluded reports whether a tool was left out.
func Excluded(name string) bool {
	excludedMu.RLock()
	defer excludedMu.RUnlock()

	return excluded[name]
}
