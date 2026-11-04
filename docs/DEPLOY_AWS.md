# Deploying on AWS EC2

The setup is one EC2 instance running the same `docker compose` stack as on a
laptop: nginx on port 80 in front of the API. There is no load balancer and no
database, and nothing costs money except the instance. It takes about 30
minutes the first time.

```
Reviewer's browser ──HTTP :80──▶ EC2 [ nginx gateway ──▶ urja-api ] ──HTTPS──▶ Urja portal
```

## 0. What you need

- An AWS account, and a public GitHub repository with this code (step 1).
- The portal credentials and your API keys. These go only into a `.env` file
  on the server, never into git.

### Instance size

At runtime the API uses about 60 to 100 MB of memory (403 meters, size-limited
caches). The heaviest moment is `docker compose up --build`, when `npm ci` and
the TypeScript compiler run.

| Instance | RAM | Verdict |
|---|---|---|
| t3.micro / t2.micro (free tier) | 1 GB | Works with the 2 GB swap the setup script adds, but the build is slow |
| **t3.small** | 2 GB | **Recommended**: enough for both build and runtime |
| t3.medium | 4 GB | More than enough. Fine if you already have it, but not needed |

Use **Ubuntu Server 24.04 LTS** with a 20 GB gp3 disk. Pick a region close to
you (for India, `ap-south-1` Mumbai). Check current prices on the EC2 pricing
page, and **stop the instance when the review is over**.

## 1. Put the code on GitHub (from your Windows PC)

Create an empty **public** repository on github.com, for example `urja-api`.
Don't add a README or .gitignore; the project already has them. Then, in Git
Bash, in the project folder:

```bash
git init -b main
git add .
git status                       # check: no .env, no fixtures/local, no node_modules, no dist
git check-ignore -v .env         # must print the .gitignore rule; if it prints nothing, STOP
git commit -m "Urja API: clean REST API over the Urja Meter Ops portal"
git remote add origin https://github.com/<you>/urja-api.git
git push -u origin main
```

On GitHub, open the **Actions** tab. The CI run (typecheck, 231 tests, build,
Docker build) should turn green within a few minutes.

## 2. Launch the instance (AWS console)

EC2 → **Launch instance**:

1. Name it `urja-api`. Image: **Ubuntu Server 24.04 LTS (64-bit x86)**.
2. Instance type: **t3.small** (or t3.medium).
3. Key pair: create one (`urja-key`, type RSA, format `.pem`) and keep the file
   safe. It is the only way to log in.
4. Network settings → **Create security group** with exactly these inbound
   rules:

   | Type | Port | Source | Why |
   |---|---|---|---|
   | SSH | 22 | **My IP** | only you can log in |
   | HTTP | 80 | Anywhere (0.0.0.0/0) | reviewers can reach nginx |

   Don't open port 3000. The API should only be reachable through nginx.
5. Storage: 20 GB gp3. Launch.
6. Optional but useful: **Elastic IPs → Allocate → Associate** it with the
   instance, so the address stays the same if you stop and start it.

Note the instance's **Public IPv4 address**. It is `<EC2_IP>` below.

## 3. Log in and install Docker

From Git Bash or PowerShell on your PC:

```bash
ssh -i path/to/urja-key.pem ubuntu@<EC2_IP>
```

If Windows says the key's permissions are too open, use Git Bash and run
`chmod 400 urja-key.pem` first.

On the server:

```bash
git clone https://github.com/<you>/urja-api.git
cd urja-api
bash deploy/ec2-setup.sh     # installs Docker + Compose, adds 2 GB swap, checks the portal is reachable
exit                         # log out once so the docker group takes effect
```

Log back in with the same `ssh` command.

## 4. Set the secrets on the server

```bash
cd urja-api
cp .env.example .env
openssl rand -base64 24 | tr '+/' '-_'      # creates a random key for yourself
nano .env
```

Set at least:

```bash
PORTAL_EMAIL=<portal account from the brief>
PORTAL_PASSWORD=<portal password>
API_KEYS=sameer:<your key>,tester:uKmXzDqwVrlosCHMOThjrkJeeILTQop6
```

`tester` is the reviewer key published in the README, so a reviewer can use
the same key locally and on the server. Remove it from `API_KEYS` after the
review.

Leave `TRUST_PROXY` as it is (Compose sets it to 1 for nginx). Only set
`CORS_ORIGINS` if a browser app on another domain will call the API directly.
Save (Ctrl+O, Enter, Ctrl+X), then:

```bash
chmod 600 .env               # only your user can read it
```

## 5. Start it

```bash
docker compose up -d --build     # the first build takes a few minutes on t3.small
docker compose ps                # api: Up (healthy), gateway: Up
curl -s localhost/health         # {"status":"ok",...}
curl -s localhost/ready          # "ready":true once the catalog has loaded (a few seconds)
docker compose logs -f api       # Ctrl+C to stop following
```

From your PC's browser, open `http://<EC2_IP>/docs`, click **Authorize**, paste
a key and try `GET /v1/meters`. Or:

```bash
curl -H "X-API-Key: uKmXzDqwVrlosCHMOThjrkJeeILTQop6" "http://<EC2_IP>/v1/meters?status=faulty&limit=2"
```

The containers restart by themselves after a crash or a reboot
(`restart: unless-stopped`, and Docker starts at boot).

## 6. Give the reviewer access

The reviewer needs two things:

- the URL `http://<EC2_IP>/docs`
- the `tester` key (already in the README)

Each consumer has its own named key. So the reviewer's requests show up as
`consumer: "tester"` in the logs, and you can turn their key off without
touching yours: remove it from `API_KEYS`, then run
`docker compose up -d --force-recreate api`.

## 7. Day-to-day

| Task | Command (in `~/urja-api`) |
|---|---|
| Deploy a new version | `git push` (once 7a is set up), or on the server `bash deploy/deploy.sh` |
| Change `.env` | edit it, then `docker compose up -d --force-recreate api` |
| Logs | `docker compose logs --tail 100 api` (JSON, one line per request) |
| Status and memory | `docker compose ps`, `docker stats --no-stream` |
| Stop / start | `docker compose down` / `docker compose up -d` |
| Free disk from old images | `docker image prune -f` |

Stopping the instance in the console stops the compute bill. The disk is still
billed, at a few cents a month. **Terminate** the instance when you are
completely done.

## 7a. Deploy automatically on push (GitHub Actions)

Once this is set up, a `git push` to `main` is the whole deploy. CI runs the
tests. Only if they pass, a second workflow connects to the instance over SSH
and runs `deploy/deploy.sh`. That script does `git pull --ff-only` and
`docker compose up -d --build`, waits for `/ready`, and prints `/health`. A
failed deploy shows red in the Actions tab, with the API's last log lines.

```
git push ──▶ CI (typecheck, tests, build, docker) ──green──▶ Deploy ──ssh──▶ EC2: deploy/deploy.sh
```

**1. A deploy key that can only deploy** (on the server):

```bash
ssh-keygen -t ed25519 -f ~/gh_deploy -N "" -C github-deploy
# Lock the key to the deploy script: it cannot open a shell or run anything else.
echo "command=\"bash /home/ubuntu/urja-api/deploy/deploy.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat ~/gh_deploy.pub)" >> ~/.ssh/authorized_keys
cat ~/gh_deploy        # copy the whole PRIVATE key (BEGIN ... END lines included)
rm ~/gh_deploy ~/gh_deploy.pub
```

**2. Secrets on GitHub.** Repo → Settings → Secrets and variables → Actions →
New repository secret. Add three:

| Name | Value |
|---|---|
| `EC2_HOST` | the instance's public IP, for example `15.252.70.41` (use an Elastic IP so it doesn't change) |
| `EC2_USER` | `ubuntu` |
| `EC2_SSH_KEY` | the private key from step 1 |

**3. The workflow.** It is already in the repo at
`.github/workflows/deploy.yml`, next to `ci.yml`. Nothing to move.

**4. Let GitHub reach SSH.** GitHub's runners connect from changing IP
addresses, so "SSH from My IP" blocks them. For this review setup, change the
SSH rule in the security group to `0.0.0.0/0`. That is acceptable here
because:

- Ubuntu on EC2 only accepts key logins, never passwords;
- your own key and the locked deploy key are the only keys;
- the deploy key can run nothing except the deploy script.

A stricter option is a self-hosted runner on the instance (no inbound SSH at
all), or a workflow that adds its own IP to the security group for the length
of the job using AWS credentials. Both are more setup than this assignment
needs.

To test it: Actions tab → Deploy → **Run workflow**, or push any commit to
`main`. Never edit tracked files on the server. If you do, `git pull --ff-only`
refuses and the deploy fails on purpose, instead of overwriting your edit.
`.env` is not tracked, so it is never touched.

## 8. Troubleshooting

| Symptom | What to check |
|---|---|
| The browser can't reach `http://<EC2_IP>` | The security group allows HTTP 80 from 0.0.0.0/0; `docker compose ps` shows the gateway Up; you used `http://`, not `https://` |
| `/ready` stays 503 | Run `docker compose logs api`. A `catalog.refresh_failed` with a login error means wrong credentials in `.env`. "could not reach" means AWS can't reach the portal (try `curl -I https://urja-ops.flockenergy.tech` on the server). The service keeps retrying by itself (30 s, 60 s, ... up to 5 min) |
| `401` on every `/v1` call | Send only the key part (after `name:`), as `X-API-Key` or `Authorization: Bearer` |
| `429` | nginx allows 20 requests/s per IP (burst 40); the API allows 300 a minute per key |
| Build killed or very slow | Not enough memory. Check that `free -h` shows the swap, or use t3.small |
| `permission denied ... docker.sock` | You didn't log out and back in after the setup script |
| `ssh: connection timed out` | Your IP changed. Set the SSH rule to "My IP" again |

## 9. HTTPS (optional, needs a domain; not tested in this repo)

Plain HTTP is fine for a review, but API keys travel unencrypted. With a
domain pointing at the Elastic IP, the simplest route is:

1. open port 443 in the security group;
2. get a certificate with certbot on the host;
3. add a `listen 443 ssl` server block to `deploy/nginx.conf`, with the
   certificate mounted into the gateway container.

Another option is an AWS Application Load Balancer with an ACM certificate in
front. Both go beyond what this assignment needs, so they are described here
but not scripted.

## Security checklist

- [ ] `.env` is not in git (`git check-ignore -v .env` prints a rule) and is `chmod 600` on the server
- [ ] SSH (22) is open only to your IP (or to 0.0.0.0/0 with key-only login and the locked deploy key, see 7a); port 3000 is not open at all
- [ ] The reviewer uses the `tester` key, which you remove after the review
- [ ] The API container runs as a non-root user on a read-only filesystem (`docker compose exec api id`)
- [ ] The instance is stopped or terminated after the review
