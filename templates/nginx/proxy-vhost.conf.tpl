# proxy {{name}}
server {
  listen 80;
  listen [::]:80;
  server_name {{serverNames}};
  {{#acmeChallenge}}
  location ^~ /.well-known/acme-challenge/ {
    root {{acmeChallengeRoot}};
    default_type "text/plain";
    allow all;
  }
  {{/acmeChallenge}}
  {{#redirectHttps}}
  location / {
    return 301 https://$host$request_uri;
  }
  {{/redirectHttps}}
  {{^redirectHttps}}
  {{#accessLog}}
  access_log {{accessLogPath}} bento_timed;
  {{/accessLog}}
  location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass {{upstream}};
  }
  {{/redirectHttps}}
}

server {
  listen 443 ssl;
  listen [::]:443 ssl;
  http2 on;
  server_name {{serverNames}};
  include {{sslInclude}};
  {{#accessLog}}
  access_log {{accessLogPath}} bento_timed;
  {{/accessLog}}
  location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass {{upstream}};
  }
}
