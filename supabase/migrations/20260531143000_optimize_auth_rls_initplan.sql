-- Otimiza policies RLS para avaliar auth.uid() uma vez por consulta.

DO $$
DECLARE
  p record;
  using_clause text;
  check_clause text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname IN ('public', 'storage')
      AND (
        qual LIKE '%auth.uid()%'
        OR with_check LIKE '%auth.uid()%'
      )
  LOOP
    using_clause := '';
    check_clause := '';

    IF p.qual IS NOT NULL THEN
      using_clause := format(
        ' USING (%s)',
        replace(p.qual, 'auth.uid()', '(select auth.uid())')
      );
    END IF;

    IF p.with_check IS NOT NULL THEN
      check_clause := format(
        ' WITH CHECK (%s)',
        replace(p.with_check, 'auth.uid()', '(select auth.uid())')
      );
    END IF;

    EXECUTE format(
      'ALTER POLICY %I ON %I.%I%s%s',
      p.policyname,
      p.schemaname,
      p.tablename,
      using_clause,
      check_clause
    );
  END LOOP;
END;
$$;
