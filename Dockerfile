# syntax=docker/dockerfile:1
FROM golang:1.27-alpine AS build
WORKDIR /src
RUN apk add --no-cache make git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=docker
RUN make build VERSION=$VERSION

FROM scratch
COPY --from=build /src/bin/nullraum /nullraum
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["/nullraum"]
CMD ["serve", "-addr", ":8080"]
