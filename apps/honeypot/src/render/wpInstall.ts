import { esc } from "./layout.js";

/**
 * Replica of WordPress core's real wp-admin/install.php — field names, form structure, and
 * copy pulled directly from the WordPress core source (github.com/WordPress/WordPress,
 * wp-admin/install.php) rather than approximated from memory, specifically so this holds up to
 * scrutiny from both a human attacker and any tooling that parses the form for WordPress's real
 * field names (weblog_title/user_name/admin_password/admin_password2/admin_email). Deliberately
 * NOT wrapped in this site's own Meridian layout — a real install.php is its own bare admin
 * screen, not themed into the surrounding site. See docs/VULNERABILITY.md.
 */

function head(title: string): string {
  return `<!doctype html>
<html lang="en-US">
<head>
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
	<meta name="robots" content="noindex,nofollow" />
	<title>${esc(title)}</title>
	<style>
		body { background: #f0f0f1; color: #3c434a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; margin: 0; padding: 0; }
		#logo { text-align: center; margin: 24px 0 0; font-size: 0; }
		#logo::after { content: "WordPress"; font-size: 32px; color: #23282d; font-weight: 400; }
		h1 { font-size: 24px; font-weight: 400; margin: 24px auto 16px; text-align: center; }
		form, .message, .install-success { background: #fff; border: 1px solid #c3c4c7; box-shadow: 0 1px 1px rgba(0,0,0,.04); padding: 26px 24px; margin: 20px auto; max-width: 496px; }
		p { max-width: 496px; margin: 16px auto; line-height: 1.5; }
		h2 { max-width: 496px; margin: 24px auto 4px; font-size: 18px; font-weight: 400; }
		.form-table { width: 100%; border-collapse: collapse; }
		.form-table th { text-align: left; font-weight: 600; padding: 12px 0 0; width: 30%; vertical-align: top; }
		.form-table td { padding: 4px 0 12px; }
		input[type=text], input[type=password], input[type=email] { width: 100%; max-width: 300px; padding: 6px 8px; border: 1px solid #8c8f94; border-radius: 3px; box-sizing: border-box; }
		.description { color: #646970; display: block; margin-top: 4px; }
		.step { text-align: center; }
		#submit, .button-primary { background: #2271b1; border-color: #2271b1; color: #fff; border-radius: 3px; padding: 10px 24px; font-size: 14px; border-style: solid; border-width: 1px; cursor: pointer; }
		.install-success td, .install-success th { text-align: left; padding: 6px 12px 6px 0; }
		a { color: #2271b1; }
		code { background: #f0f0f1; padding: 2px 6px; }
	</style>
</head>
<body class="wp-core-ui admin-color-modern">
<p id="logo"></p>
`;
}

export function wpInstallStep1Page(): string {
  return (
    head("WordPress &rsaquo; Installation") +
    `<h1>Welcome</h1>
<p>Welcome to the famous five-minute WordPress installation process! Just fill in the information below and you&#8217;ll be on your way to using the most extendable and powerful personal publishing platform in the world.</p>

<h2>Information needed</h2>
<p>Please provide the following information. Do not worry, you can always change these settings later.</p>

<form id="setup" method="post" action="install.php?step=2" novalidate="novalidate">
	<table class="form-table" role="presentation">
		<tr>
			<th scope="row"><label for="weblog_title">Site Title</label></th>
			<td><input name="weblog_title" type="text" id="weblog_title" size="25" /></td>
		</tr>
		<tr>
			<th scope="row"><label for="user_login">Username</label></th>
			<td>
				<input name="user_name" type="text" id="user_login" size="25" aria-describedby="user-name-desc" />
				<p id="user-name-desc" class="description">Usernames can have only alphanumeric characters, spaces, underscores, hyphens, periods, and the @ symbol.</p>
			</td>
		</tr>
		<tr class="form-field form-required user-pass1-wrap">
			<th scope="row"><label for="pass1">Password</label></th>
			<td>
				<input type="password" name="admin_password" id="pass1" class="regular-text" autocomplete="new-password" spellcheck="false" aria-describedby="admin-password-desc" />
				<p id="admin-password-desc" class="description"><strong>Important:</strong> You will need this password to log in. Please store it in a secure location.</p>
			</td>
		</tr>
		<tr class="form-field form-required user-pass2-wrap">
			<th scope="row"><label for="pass2">Repeat Password <span class="description">(required)</span></label></th>
			<td><input type="password" name="admin_password2" id="pass2" autocomplete="new-password" spellcheck="false" /></td>
		</tr>
		<tr>
			<th scope="row"><label for="admin_email">Your Email</label></th>
			<td>
				<input name="admin_email" type="email" id="admin_email" size="25" aria-describedby="admin-email-desc" />
				<p id="admin-email-desc" class="description">Double-check your email address before continuing.</p>
			</td>
		</tr>
		<tr>
			<th scope="row">Search engine visibility</th>
			<td>
				<label for="blog_public"><input name="blog_public" type="checkbox" id="blog_public" value="0" /> Discourage search engines from indexing this site</label>
				<p class="description">It is up to search engines to honor this request.</p>
			</td>
		</tr>
	</table>
	<p class="step"><input type="submit" id="submit" class="button-primary" value="Install WordPress" name="Submit" /></p>
	<input type="hidden" name="language" value="" />
</form>
</body>
</html>`
  );
}

export function wpSetupConfigPage(): string {
  return (
    head("WordPress &rsaquo; Setup Configuration File") +
    `<h1 class="screen-reader-text">Set up your database connection</h1>
<form method="post" action="setup-config.php?step=2">
	<p>Below you should enter your database connection details. If you are not sure about these, contact your host.</p>
	<table class="form-table" role="presentation">
		<tr>
			<th scope="row"><label for="dbname">Database Name</label></th>
			<td><input name="dbname" id="dbname" type="text" aria-describedby="dbname-desc" size="25" placeholder="wordpress" />
			<p id="dbname-desc" class="description">The name of the database you want to use with WordPress.</p></td>
		</tr>
		<tr>
			<th scope="row"><label for="uname">Username</label></th>
			<td><input name="uname" id="uname" type="text" aria-describedby="uname-desc" size="25" placeholder="username" />
			<p id="uname-desc" class="description">Your database username.</p></td>
		</tr>
		<tr>
			<th scope="row"><label for="pwd">Password</label></th>
			<td><input name="pwd" id="pwd" type="password" size="25" placeholder="password" autocomplete="off" spellcheck="false" />
			<p class="description">Your database password.</p></td>
		</tr>
		<tr>
			<th scope="row"><label for="dbhost">Database Host</label></th>
			<td><input name="dbhost" id="dbhost" type="text" aria-describedby="dbhost-desc" size="25" value="localhost" />
			<p id="dbhost-desc" class="description">You should be able to get this info from your web host, if <code>localhost</code> does not work.</p></td>
		</tr>
		<tr>
			<th scope="row"><label for="prefix">Table Prefix</label></th>
			<td><input name="prefix" id="prefix" type="text" value="wp_" size="25" />
			<p class="description">If you want to run multiple WordPress installations in a single database, change this.</p></td>
		</tr>
	</table>
	<input type="hidden" name="language" value="" />
	<p class="step"><input name="submit" type="submit" value="Submit" class="button-primary" /></p>
</form>
</body>
</html>`
  );
}

export function wpInstallAlreadyPage(): string {
  return (
    head("WordPress &rsaquo; Installation") +
    `<div class="message"><h1>Already Installed</h1>
<p>You appear to have already installed WordPress. To reinstall please clear your old database tables first.</p>
<p class="step"><a href="/wp-login.php">Log In</a></p></div>
</body>
</html>`
  );
}

export function wpInstallSuccessPage(opts: { username: string }): string {
  return (
    head("WordPress &rsaquo; Installation") +
    `<h1>Success!</h1>
<p>WordPress has been installed. Thank you, and enjoy!</p>
<table class="form-table install-success">
	<tr><th>Username</th><td>${esc(opts.username)}</td></tr>
	<tr><th>Password</th><td><p>Your chosen password.</p></td></tr>
</table>
<p class="step"><a href="/wp-login.php">Log In</a></p>
</body>
</html>`
  );
}
