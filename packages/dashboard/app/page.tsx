import { redirect } from 'next/navigation';

export default function Home() {
  // The middleware sends signed-in users to /dashboard before this renders.
  redirect('/login');
}
