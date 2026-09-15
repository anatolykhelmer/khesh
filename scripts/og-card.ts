export function ogCardHtml(input: { fontDataUri: string; shotDataUri: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      @font-face {
        font-family: "Heebo Card";
        src: url("${input.fontDataUri}") format("woff2");
        font-weight: 100 900;
      }
      * { box-sizing: border-box; margin: 0; }
      body {
        width: 1200px;
        height: 630px;
        display: flex;
        align-items: center;
        gap: 64px;
        padding: 72px;
        background: #f7f5f2;
        color: #1c1917;
        font-family: "Heebo Card", system-ui, sans-serif;
      }
      .copy { flex: 1; }
      .brand {
        font-size: 20px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #6d655e;
        margin-bottom: 20px;
      }
      h1 { font-size: 58px; line-height: 1.1; font-weight: 700; margin-bottom: 32px; }
      ul { list-style: none; padding: 0; font-size: 24px; line-height: 1.9; color: #6d655e; }
      li::before { content: "— "; color: #7c3aed; }
      .phone {
        width: 300px;
        height: 486px;
        border: 10px solid #1c1917;
        border-radius: 42px;
        overflow: hidden;
        box-shadow: 0 24px 60px rgb(28 25 23 / 0.18);
      }
      .phone img { width: 100%; display: block; }
    </style>
  </head>
  <body>
    <div class="copy">
      <p class="brand">Khesh</p>
      <h1>A household ledger<br />that runs in your browser</h1>
      <ul>
        <li>Double-entry, not a spreadsheet</li>
        <li>No account, no server</li>
        <li>Your Drive, not ours</li>
      </ul>
    </div>
    <div class="phone"><img src="${input.shotDataUri}" alt="" /></div>
  </body>
</html>`;
}
