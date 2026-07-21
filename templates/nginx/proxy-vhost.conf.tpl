# proxy {{name}}
upstream {{upstreamName}} {
  {{#upstreamServers}}
  server {{.}};
  {{/upstreamServers}}
  keepalive 5;
}

server {
  listen 80;
  listen [::]:80;
  server_name {{serverNames}};
  {{#redirectHttps}}
  location / {
    return 301 https://$host$request_uri;
  }
  {{/redirectHttps}}
  {{^redirectHttps}}
  {{#accessLog}}
  access_log {{accessLogPath}} bento_access_log;
  {{/accessLog}}
  location ~* \.(?:css|js|mjs|jpg|jpeg|gif|png|svg|ico|webp|avif|woff|woff2|ttf|eot)$ {
    expires 30d;
    proxy_cache proxy_assets;
    proxy_cache_valid 200 7d;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass {{upstreamScheme}}://{{upstreamName}}{{upstreamUri}};
  }
  location / {
    # proxy_cache proxy_cache;
    # proxy_cache_valid 200 7d;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass {{upstreamScheme}}://{{upstreamName}}{{upstreamUri}};
  }
  {{/redirectHttps}}
}

server {
  listen 443 ssl;
  listen [::]:443 ssl;
  {{#http3}}
  listen 443 quic;
  listen [::]:443 quic;
  {{/http3}}
  http2 on;
  server_name {{serverNames}};
  {{#sslCertificate}}
  ssl_certificate     {{sslCertificate}};
  ssl_certificate_key {{sslCertificateKey}};
  {{/sslCertificate}}
  include {{sslInclude}};
  {{#http3}}
  add_header Alt-Svc 'h3=":443"; ma=86400' always;
  {{/http3}}
  {{#accessLog}}
  access_log {{accessLogPath}} bento_access_log;
  {{/accessLog}}
  location ~* \.(?:css|js|mjs|jpg|jpeg|gif|png|svg|ico|webp|avif|woff|woff2|ttf|eot)$ {
    expires 30d;
    proxy_cache proxy_assets;
    proxy_cache_valid 200 7d;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass {{upstreamScheme}}://{{upstreamName}}{{upstreamUri}};
  }
  location / {
    # proxy_cache proxy_cache;
    # proxy_cache_valid 200 7d;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass {{upstreamScheme}}://{{upstreamName}}{{upstreamUri}};
  }
}
