# Build Stage
FROM golang:1.23-alpine AS builder

WORKDIR /app

# Download dependencies
COPY go.mod go.sum ./
RUN go mod download || true

# Copy source code
COPY . .

# Build self-contained static executable
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/twowayradio ./cmd/server

# Final Runtime Stage
FROM alpine:3.20

# Install SSL certificates, timezone data, and healthcheck tool
RUN apk add --no-cache ca-certificates tzdata wget

WORKDIR /app
COPY --from=builder /app/twowayradio /app/twowayradio

# Ensure uploads directory and declare volume
RUN mkdir -p /app/data/uploads
VOLUME ["/app/data/uploads"]

# Expose HTTP / WebSocket and RoIP UDP ports
EXPOSE 8080 5005/udp

# Healthcheck for Docker / Container Orchestrators
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/app/twowayradio"]
CMD ["-port", "8080", "-udp", "5005", "-tot", "60"]
