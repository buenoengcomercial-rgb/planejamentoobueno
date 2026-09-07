-- Impede que uma gravação introduza nova duplicidade de NF aprovada.
-- A numeração é comparada sem pontuação e sem zeros à esquerda, mas o valor
-- original permanece preservado dentro de data_json para exibição/auditoria.
CREATE OR REPLACE FUNCTION public.reject_new_duplicate_fiscal_notes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    WITH new_groups AS (
      SELECT
        regexp_replace(COALESCE(note ->> 'supplierCnpj', ''), '\D', '', 'g') AS supplier_cnpj,
        COALESCE(NULLIF(ltrim(regexp_replace(COALESCE(note ->> 'invoiceNumber', ''), '\D', '', 'g'), '0'), ''), '0') AS invoice_number,
        round(COALESCE(NULLIF(note ->> 'totalAmount', '')::numeric, 0), 2) AS total_amount,
        count(*) AS occurrences
      FROM jsonb_array_elements(COALESCE(NEW.data_json #> '{warehouse,fiscalNotes}', '[]'::jsonb)) note
      WHERE note ->> 'status' = 'aprovada'
        AND regexp_replace(COALESCE(note ->> 'supplierCnpj', ''), '\D', '', 'g') <> ''
        AND regexp_replace(COALESCE(note ->> 'invoiceNumber', ''), '\D', '', 'g') <> ''
      GROUP BY 1, 2, 3
    ), old_groups AS (
      SELECT
        regexp_replace(COALESCE(note ->> 'supplierCnpj', ''), '\D', '', 'g') AS supplier_cnpj,
        COALESCE(NULLIF(ltrim(regexp_replace(COALESCE(note ->> 'invoiceNumber', ''), '\D', '', 'g'), '0'), ''), '0') AS invoice_number,
        round(COALESCE(NULLIF(note ->> 'totalAmount', '')::numeric, 0), 2) AS total_amount,
        count(*) AS occurrences
      FROM jsonb_array_elements(COALESCE(OLD.data_json #> '{warehouse,fiscalNotes}', '[]'::jsonb)) note
      WHERE note ->> 'status' = 'aprovada'
        AND regexp_replace(COALESCE(note ->> 'supplierCnpj', ''), '\D', '', 'g') <> ''
        AND regexp_replace(COALESCE(note ->> 'invoiceNumber', ''), '\D', '', 'g') <> ''
      GROUP BY 1, 2, 3
    )
    SELECT 1
    FROM new_groups new_group
    LEFT JOIN old_groups old_group USING (supplier_cnpj, invoice_number, total_amount)
    WHERE new_group.occurrences > 1
      AND new_group.occurrences > COALESCE(old_group.occurrences, 0)
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_FISCAL_NOTE: uma nota fiscal com o mesmo CNPJ, número e valor já está lançada.'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS projects_reject_new_duplicate_fiscal_notes ON public.projects;
CREATE TRIGGER projects_reject_new_duplicate_fiscal_notes
BEFORE UPDATE OF data_json ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.reject_new_duplicate_fiscal_notes();
