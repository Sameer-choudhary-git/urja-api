proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
# The API reuses this id in its logs and echoes it back (X-Request-Id).
proxy_set_header X-Request-Id $request_id;
