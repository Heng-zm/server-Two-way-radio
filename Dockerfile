# Build Stage
FROM golang:1.23-alpine AS builder

WORKDIR /app

# Download dependencies
COPY go.mod ./
RUN go mod download || true

# Copy source code
COPY . .

# Build self-contained static executable
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/twowayradio ./cmd/server

# Final Runtime Stage
FROM alpine:3.20

WORKDIR /app
COPY --from=builder /app/twowayradio /app/twowayradio

# Expose HTTP / WebSocket and RoIP UDP ports
EXPOSE 8080 5005/udp

ENTRYPOINT ["/app/twowayradio"]
CMD ["-port", "8080", "-udp", "5005", "-tot", "60"]
