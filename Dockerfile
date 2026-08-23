FROM node:24-alpine AS web-build

WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS go-build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY --from=web-build /src/web/dist/ ./internal/webui/dist/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/gateway ./cmd/gateway

FROM alpine:3.23

RUN apk add --no-cache ffmpeg libsrt-progs \
    && addgroup -S gateway && adduser -S -G gateway gateway \
    && mkdir -p /var/lib/webrtc-gateway \
    && chown gateway:gateway /var/lib/webrtc-gateway
COPY --from=go-build /out/gateway /usr/local/bin/gateway

USER gateway
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/gateway"]
