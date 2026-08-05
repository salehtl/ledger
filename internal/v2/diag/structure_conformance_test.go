package diag

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type structureVector struct {
	Name   string `json:"name"`
	Source string `json:"source"`
	Sig    string `json:"sig"`
}
type structureManifest struct {
	SchemaVersion int               `json:"schema_version"`
	Cases         []structureVector `json:"cases"`
}

func TestStructureConformanceManifest(t *testing.T) {
	root := filepath.Join("..", "..", "..")
	b, err := os.ReadFile(filepath.Join(root, "conformance", "structure", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest structureManifest
	if err := json.Unmarshal(b, &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Cases) < 200 {
		t.Fatalf("structure conformance shrank to %d cases", len(manifest.Cases))
	}
	bySource := map[string]map[string]string{}
	for _, v := range manifest.Cases {
		cases := bySource[v.Source]
		if cases == nil {
			data, err := os.ReadFile(filepath.Join(root, v.Source))
			if err != nil {
				t.Fatal(err)
			}
			var doc struct {
				Cases []struct {
					Name string `json:"name"`
					Body string `json:"normalized_body_base64"`
				} `json:"cases"`
			}
			if err := json.Unmarshal(data, &doc); err != nil {
				t.Fatal(err)
			}
			cases = map[string]string{}
			for _, c := range doc.Cases {
				cases[c.Name] = c.Body
			}
			bySource[v.Source] = cases
		}
		body, ok := cases[v.Name]
		if !ok {
			t.Fatalf("%s missing from %s", v.Name, v.Source)
		}
		raw, err := base64.StdEncoding.DecodeString(body)
		if err != nil {
			t.Fatal(err)
		}
		if got := StructureSig(string(raw)); got != v.Sig {
			t.Fatalf("%s: got %s want %s", v.Name, got, v.Sig)
		}
	}
}
