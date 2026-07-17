# app {{slug}}
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
  root {{docRoot}};
  include /etc/nginx/snippets/app-common.conf;

  {{#accessLog}}
  access_log {{accessLogPath}} bento_timed;
  {{/accessLog}}

  {{#deployEnabled}}
  location = /_bento/deploy {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /opt/bento/helpers/deploy-webhook.php;
    fastcgi_param BENTO_DEPLOY_SECRET "{{deploySecret}}";
    fastcgi_param BENTO_APP "{{slug}}";
    fastcgi_pass unix:{{socketPath}};
  }
  location = /_bento/clean-opcache {
    internal;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /opt/bento/helpers/clean-opcache.php;
    fastcgi_param BENTO_APP "{{slug}}";
    fastcgi_pass unix:{{socketPath}};
  }
  {{/deployEnabled}}

  {{#frontController}}
  location / {
    try_files $uri $uri/ /index.php?$query_string;
  }
  location ~ \.php$ {
    if ($uri !~ ^/index\.php$) { return 404; }
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_pass unix:{{socketPath}};
  }
  {{/frontController}}
  {{#legacy}}
  location / {
    try_files $uri $uri/ =404;
  }
  location ~ \.php$ {
    try_files $uri =404;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_pass unix:{{socketPath}};
  }
  {{/legacy}}
  {{/redirectHttps}}
}

server {
  listen 443 ssl;
  listen [::]:443 ssl;
  http2 on;
  server_name {{serverNames}};

  include {{sslInclude}};
  add_header Alt-Svc 'h3=":443"; ma=86400' always;

  root {{docRoot}};
  include /etc/nginx/snippets/app-common.conf;

  {{#accessLog}}
  access_log {{accessLogPath}} bento_timed;
  {{/accessLog}}

  {{#deployEnabled}}
  location = /_bento/deploy {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /opt/bento/helpers/deploy-webhook.php;
    fastcgi_param BENTO_DEPLOY_SECRET "{{deploySecret}}";
    fastcgi_param BENTO_APP "{{slug}}";
    fastcgi_pass unix:{{socketPath}};
  }
  location = /_bento/clean-opcache {
    internal;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /opt/bento/helpers/clean-opcache.php;
    fastcgi_param BENTO_APP "{{slug}}";
    fastcgi_pass unix:{{socketPath}};
  }
  {{/deployEnabled}}

  {{#frontController}}
  location / {
    try_files $uri $uri/ /index.php?$query_string;
  }
  location ~ \.php$ {
    if ($uri !~ ^/index\.php$) { return 404; }
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_pass unix:{{socketPath}};
  }
  {{/frontController}}
  {{#legacy}}
  location / {
    try_files $uri $uri/ =404;
  }
  location ~ \.php$ {
    try_files $uri =404;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_pass unix:{{socketPath}};
  }
  {{/legacy}}
}
