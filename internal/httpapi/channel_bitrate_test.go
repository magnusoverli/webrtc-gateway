package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"webrtc-gateway/internal/channel"
)

func TestChannelCompatibilityBitrateAPI(t *testing.T) {
	store, err := channel.OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service := channel.NewService(store, fakePathManager{}, nil, nil, nil)
	handler := newTestHandler(t, fakeMediaMTX{}, service, "http://127.0.0.1:1")
	request := func(method, path, body string, revision int) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if revision > 0 {
			req.Header.Set("If-Match", fmt.Sprintf(`"%d"`, revision))
		}
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		return res
	}
	const draft = `"name":"Bitrate","enabled":true,"input":{"mode":"srt-push","srt":{"port":10000}},"maxReaders":4`
	created := request(http.MethodPost, "/api/v1/channels", "{"+draft+"}", 0)
	if created.Code != http.StatusCreated {
		t.Fatalf("create=%d %s", created.Code, created.Body)
	}
	var item channelResponse
	if err := json.Unmarshal(created.Body.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	if item.CompatibilityVideoMaxKbps != 5000 {
		t.Fatalf("default bitrate=%d", item.CompatibilityVideoMaxKbps)
	}
	path := "/api/v1/channels/" + item.ID
	for _, step := range []struct {
		method, body string
		want         int
	}{
		{http.MethodPut, "{" + draft + `,"compatibilityVideoMaxKbps":3500}`, 3500},
		{http.MethodPut, "{" + draft + "}", 3500}, // Old clients must preserve custom settings.
		{http.MethodPatch, `{"enabled":false}`, 3500},
		{http.MethodPatch, `{"enabled":true}`, 3500},
		{http.MethodPut, "{" + draft + `,"compatibilityVideoMaxKbps":0}`, 5000},
	} {
		current, err := service.Get(t.Context(), item.ID)
		if err != nil {
			t.Fatal(err)
		}
		res := request(step.method, path, step.body, current.Revision)
		if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), fmt.Sprintf(`"compatibilityVideoMaxKbps":%d`, step.want)) {
			t.Fatalf("%s=%d %s, want bitrate %d", step.method, res.Code, res.Body, step.want)
		}
		stored, err := service.Get(t.Context(), item.ID)
		if err != nil || stored.CompatibilityVideoMaxKbps != step.want {
			t.Fatalf("stored bitrate=%+v, err=%v", stored, err)
		}
	}
	for _, value := range []string{"-1", "99", "40001", "3.5", `"5000"`} {
		current, _ := service.Get(t.Context(), item.ID)
		res := request(http.MethodPut, path, "{"+draft+`,"compatibilityVideoMaxKbps":`+value+"}", current.Revision)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("invalid bitrate %s=%d %s", value, res.Code, res.Body)
		}
		stored, _ := service.Get(t.Context(), item.ID)
		if stored.Revision != current.Revision || stored.CompatibilityVideoMaxKbps != current.CompatibilityVideoMaxKbps {
			t.Fatal("invalid bitrate changed stored channel")
		}
	}
}
