UPDATE tabs
SET is_active = 0
WHERE tab_name = 'original_parts'
   OR path = '/original-parts';
