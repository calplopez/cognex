import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Workflow Assistant',
  description: 'Approve a page in all language versions',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
