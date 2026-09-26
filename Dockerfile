# syntax=docker/dockerfile:1
# check=skip=all

# Build Stage
FROM golang:1.23-alpine AS builder

WORKDIR /app

# Download dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build self-contained static executable for Linux
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/twowayradio ./cmd/server

# Final Runtime Stage
FROM alpine:3.20

# Install CA certificates and timezone data
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /app/twowayradio /app/twowayradio

# Ensure storage directory exists
RUN mkdir -p /app/data/uploads

# Expose default HTTP / WebSocket port
EXPOSE 8080

# Run server (automatically respects Railway dynamic $PORT environment variable)
CMD ["/app/twowayradio"]
