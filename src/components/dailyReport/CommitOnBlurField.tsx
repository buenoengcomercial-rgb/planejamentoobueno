import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

interface CommitOnBlurFieldProps {
  value: string;
  onCommit: (value: string) => void;
}

function useCommitOnBlur(value: string, onCommit: (value: string) => void) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const committedValueRef = useRef(value);
  const dirtyRef = useRef(false);
  const onCommitRef = useRef(onCommit);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const commit = useCallback(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const next = draftRef.current;
    if (next === committedValueRef.current) return;
    committedValueRef.current = next;
    onCommitRef.current(next);
  }, []);

  useEffect(() => {
    if (dirtyRef.current || value === draftRef.current) return;
    draftRef.current = value;
    committedValueRef.current = value;
    setDraft(value);
  }, [value]);

  useEffect(() => () => commit(), [commit]);

  return {
    draft,
    onChange: (next: string) => {
      draftRef.current = next;
      dirtyRef.current = true;
      setDraft(next);
    },
    onBlur: commit,
  };
}

type DeferredInputProps = CommitOnBlurFieldProps & Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'onBlur'>;

export function CommitOnBlurInput({ value, onCommit, ...props }: DeferredInputProps) {
  const field = useCommitOnBlur(value, onCommit);
  return <Input {...props} value={field.draft} onChange={event => field.onChange(event.target.value)} onBlur={field.onBlur} />;
}

type DeferredTextareaProps = CommitOnBlurFieldProps & Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange' | 'onBlur'>;

export function CommitOnBlurTextarea({ value, onCommit, ...props }: DeferredTextareaProps) {
  const field = useCommitOnBlur(value, onCommit);
  return <Textarea {...props} value={field.draft} onChange={event => field.onChange(event.target.value)} onBlur={field.onBlur} />;
}
