import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Chat } from '@/components/Chat';

export default function ChatPage() {
  return (
    <ErrorBoundary>
      <Chat />
    </ErrorBoundary>
  );
}
