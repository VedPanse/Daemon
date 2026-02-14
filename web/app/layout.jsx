export const metadata = {
  title: "Daemon API",
  description: "Daemon ingest endpoint and deployment dashboard"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0c111d", color: "#e8eefc" }}>
        {children}
      </body>
    </html>
  );
}
