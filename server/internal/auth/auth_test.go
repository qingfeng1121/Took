package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
}

// 未配置 token 时一律放行（局域网免配置可用）。
func TestMiddlewarePassthroughWhenNoToken(t *testing.T) {
	h := Middleware("", okHandler())
	for _, header := range []string{"", "Bearer wrong"} {
		req := httptest.NewRequest(http.MethodGet, "/api/sync/pull", nil)
		if header != "" {
			req.Header.Set(TokenHeader, header)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("token 未配置时应放行（header=%q），实际 %d", header, rec.Code)
		}
	}
}

// 配了 token：不带头 / 带错 token → 401 且错误体说明原因；带对 token → 200。
func TestMiddlewareRejectsBadToken(t *testing.T) {
	const token = "s3cret"
	h := Middleware(token, okHandler())

	cases := []struct {
		name   string
		header string
		want   int
	}{
		{"无 header", "", http.StatusUnauthorized},
		{"错 token", "Bearer nope", http.StatusUnauthorized},
		{"缺 Bearer 前缀", "s3cret", http.StatusUnauthorized},
		{"Bearer 后为空", "Bearer ", http.StatusUnauthorized},
		{"对 token", "Bearer " + token, http.StatusOK},
		{"方案名大小写不敏感", "bearer " + token, http.StatusOK},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodGet, "/api/sync/pull", nil)
		if c.header != "" {
			req.Header.Set(TokenHeader, c.header)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("%s：状态码应为 %d，实际 %d", c.name, c.want, rec.Code)
		}
		if c.want == http.StatusUnauthorized {
			if got := rec.Header().Get("WWW-Authenticate"); got == "" {
				t.Errorf("%s：401 应带 WWW-Authenticate 头", c.name)
			}
			if rec.Body.Len() == 0 {
				t.Errorf("%s：401 应有明确错误体", c.name)
			}
		}
	}
}

// BearerToken 的解析细节：多空格、非 Bearer 方案都不该被当成合法 token。
func TestBearerToken(t *testing.T) {
	cases := []struct {
		header string
		want   string
		ok     bool
	}{
		{"Bearer abc", "abc", true},
		{"Bearer   abc  ", "abc", true},
		{"Basic abc", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		if c.header != "" {
			req.Header.Set(TokenHeader, c.header)
		}
		got, ok := BearerToken(req)
		if got != c.want || ok != c.ok {
			t.Errorf("BearerToken(%q) = (%q,%v)，应为 (%q,%v)", c.header, got, ok, c.want, c.ok)
		}
	}
}
