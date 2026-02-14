export default function HomePage() {
  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "48px 20px" }}>
      <h1 style={{ marginTop: 0 }}>Daemon Vercel App</h1>
      <p>This app hosts the publish API used by the CLI.</p>

      <section style={{ border: "1px solid #23314f", borderRadius: 12, padding: 16, marginTop: 20 }}>
        <h2 style={{ marginTop: 0 }}>Endpoints</h2>
        <ul>
          <li><code>GET /api/health</code></li>
          <li><code>POST /api/v1/daemon-configs/ingest</code></li>
        </ul>
      </section>

      <section style={{ border: "1px solid #23314f", borderRadius: 12, padding: 16, marginTop: 20 }}>
        <h2 style={{ marginTop: 0 }}>CLI Example</h2>
        <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
{`daemon build \\
  --context-dir daemon-cli/firmware-code/profiles/rc_car_pi_arduino \\
  --profile rc_car_pi_arduino \\
  --publish \\
  --publish-url https://<your-vercel-domain>/api/v1/daemon-configs/ingest`}
        </pre>
      </section>
    </main>
  );
}
