// 鉴权（契约 §7.1 的 Authorization: Bearer <token>）。
//
// 取舍：**只有配了 token 才校验**。局域网自部署的单用户场景里，多一步配置就多一次
// 「打不开」的风险，默认免配置可用比默认安全更重要；要暴露到更大网络时再加 token。
// 保护面只有同步与导出（会写库、会吐全量数据），只读接口 /api/health 永远公开，
// 否则客户端连「后端在不在」都探测不了。
package auth

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// TokenHeader 是契约 §7.1 规定的鉴权头。
const TokenHeader = "Authorization"

// Middleware 返回包了鉴权的 handler。token 为空时原样放行（未配置 = 不校验）。
//
// 比对用 subtle.ConstantTimeCompare：局域网里 token 泄露的方式有很多，
// 能不给计时旁路就别给；逐字节比较在这里零成本。
func Middleware(token string, next http.Handler) http.Handler {
	if token == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := BearerToken(r)
		if !ok || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			writeUnauthorized(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// BearerToken 从 Authorization 头里取 token；头缺失、格式不对都返回 ok=false。
// 方案名按 RFC 6750 大小写不敏感（Bearer / bearer 都收）。
func BearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get(TokenHeader)
	if h == "" {
		return "", false
	}
	const scheme = "bearer "
	if len(h) <= len(scheme) || !strings.EqualFold(h[:len(scheme)], scheme) {
		return "", false
	}
	tok := strings.TrimSpace(h[len(scheme):])
	if tok == "" {
		return "", false
	}
	return tok, true
}

// writeUnauthorized 回 401 + 明确错误体：客户端要能一眼分清「没带 token」和「token 错了」，
// 而不是把 401 当成网络故障静默重试。
func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("WWW-Authenticate", `Bearer realm="took"`)
	w.WriteHeader(http.StatusUnauthorized)
	w.Write([]byte(`{"ok":false,"error":"unauthorized","message":"需要 Authorization: Bearer <token>"}` + "\n"))
}
