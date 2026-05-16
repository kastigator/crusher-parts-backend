UPDATE measurement_units SET code = 'шт', symbol = 'шт' WHERE code = 'pcs';
UPDATE measurement_units SET code = 'компл', symbol = 'компл.' WHERE code = 'set';
UPDATE measurement_units SET code = 'кг', symbol = 'кг' WHERE code = 'kg';
UPDATE measurement_units SET code = 'г', symbol = 'г' WHERE code = 'g';
UPDATE measurement_units SET code = 'т', symbol = 'т' WHERE code = 't';
UPDATE measurement_units SET code = 'м', symbol = 'м' WHERE code = 'm';
UPDATE measurement_units SET code = 'см', symbol = 'см' WHERE code = 'cm';
UPDATE measurement_units SET code = 'мм', symbol = 'мм' WHERE code = 'mm';
UPDATE measurement_units SET code = 'м²', symbol = 'м²' WHERE code = 'm2';
UPDATE measurement_units SET code = 'м³', symbol = 'м³' WHERE code = 'm3';
UPDATE measurement_units SET code = 'л', symbol = 'л' WHERE code = 'l';
UPDATE measurement_units SET code = 'дн', symbol = 'дн.' WHERE code = 'day';
UPDATE measurement_units SET code = 'квт', symbol = 'кВт' WHERE code = 'kw';
UPDATE measurement_units SET code = 'в', symbol = 'В' WHERE code = 'v';
UPDATE measurement_units SET code = 'гц', symbol = 'Гц' WHERE code = 'hz';
UPDATE measurement_units SET code = 'об/мин', symbol = 'об/мин' WHERE code = 'rpm';
UPDATE measurement_units SET code = 'а', symbol = 'А' WHERE code = 'a';
UPDATE measurement_units SET code = 'нм', symbol = 'Н·м' WHERE code = 'nm';
UPDATE measurement_units SET code = 'бар', symbol = 'bar' WHERE code = 'bar';
UPDATE measurement_units SET code = 'мпа', symbol = 'МПа' WHERE code = 'mpa';
UPDATE measurement_units SET code = '°c', symbol = '°C' WHERE code = 'celsius';
UPDATE measurement_units SET code = '%', symbol = '%' WHERE code = 'percent';

UPDATE oem_parts SET uom = CASE LOWER(uom)
  WHEN 'pcs' THEN 'шт' WHEN 'pc' THEN 'шт' WHEN 'piece' THEN 'шт' WHEN 'шт.' THEN 'шт'
  WHEN 'set' THEN 'компл' WHEN 'kit' THEN 'компл' WHEN 'компл.' THEN 'компл'
  WHEN 'kg' THEN 'кг' WHEN 'кг.' THEN 'кг'
  WHEN 'g' THEN 'г' WHEN 'г.' THEN 'г'
  WHEN 't' THEN 'т' WHEN 'т.' THEN 'т'
  WHEN 'm' THEN 'м' WHEN 'cm' THEN 'см' WHEN 'mm' THEN 'мм'
  WHEN 'm2' THEN 'м²' WHEN 'm²' THEN 'м²' WHEN 'м2' THEN 'м²'
  WHEN 'm3' THEN 'м³' WHEN 'm³' THEN 'м³' WHEN 'м3' THEN 'м³'
  WHEN 'l' THEN 'л' WHEN 'л.' THEN 'л'
  WHEN 'day' THEN 'дн' WHEN 'days' THEN 'дн' WHEN 'дн.' THEN 'дн'
  ELSE uom END WHERE uom IS NOT NULL;

UPDATE oem_part_model_fitments SET uom = CASE LOWER(uom)
  WHEN 'pcs' THEN 'шт' WHEN 'pc' THEN 'шт' WHEN 'piece' THEN 'шт' WHEN 'шт.' THEN 'шт'
  WHEN 'set' THEN 'компл' WHEN 'kit' THEN 'компл' WHEN 'компл.' THEN 'компл'
  WHEN 'kg' THEN 'кг' WHEN 'кг.' THEN 'кг'
  WHEN 'g' THEN 'г' WHEN 'г.' THEN 'г'
  WHEN 't' THEN 'т' WHEN 'т.' THEN 'т'
  WHEN 'm' THEN 'м' WHEN 'cm' THEN 'см' WHEN 'mm' THEN 'мм'
  WHEN 'm2' THEN 'м²' WHEN 'm²' THEN 'м²' WHEN 'м2' THEN 'м²'
  WHEN 'm3' THEN 'м³' WHEN 'm³' THEN 'м³' WHEN 'м3' THEN 'м³'
  WHEN 'l' THEN 'л' WHEN 'л.' THEN 'л'
  WHEN 'day' THEN 'дн' WHEN 'days' THEN 'дн' WHEN 'дн.' THEN 'дн'
  ELSE uom END WHERE uom IS NOT NULL;

UPDATE standard_parts SET uom = CASE LOWER(uom)
  WHEN 'pcs' THEN 'шт' WHEN 'pc' THEN 'шт' WHEN 'piece' THEN 'шт' WHEN 'шт.' THEN 'шт'
  WHEN 'set' THEN 'компл' WHEN 'kit' THEN 'компл' WHEN 'компл.' THEN 'компл'
  WHEN 'kg' THEN 'кг' WHEN 'кг.' THEN 'кг'
  WHEN 'g' THEN 'г' WHEN 'г.' THEN 'г'
  WHEN 't' THEN 'т' WHEN 'т.' THEN 'т'
  WHEN 'm' THEN 'м' WHEN 'cm' THEN 'см' WHEN 'mm' THEN 'мм'
  WHEN 'm2' THEN 'м²' WHEN 'm²' THEN 'м²' WHEN 'м2' THEN 'м²'
  WHEN 'm3' THEN 'м³' WHEN 'm³' THEN 'м³' WHEN 'м3' THEN 'м³'
  WHEN 'l' THEN 'л' WHEN 'л.' THEN 'л'
  WHEN 'day' THEN 'дн' WHEN 'days' THEN 'дн' WHEN 'дн.' THEN 'дн'
  ELSE uom END WHERE uom IS NOT NULL;

UPDATE supplier_parts SET uom = CASE LOWER(uom)
  WHEN 'pcs' THEN 'шт' WHEN 'pc' THEN 'шт' WHEN 'piece' THEN 'шт' WHEN 'шт.' THEN 'шт'
  WHEN 'set' THEN 'компл' WHEN 'kit' THEN 'компл' WHEN 'компл.' THEN 'компл'
  WHEN 'kg' THEN 'кг' WHEN 'кг.' THEN 'кг'
  WHEN 'g' THEN 'г' WHEN 'г.' THEN 'г'
  WHEN 't' THEN 'т' WHEN 'т.' THEN 'т'
  WHEN 'm' THEN 'м' WHEN 'cm' THEN 'см' WHEN 'mm' THEN 'мм'
  WHEN 'm2' THEN 'м²' WHEN 'm²' THEN 'м²' WHEN 'м2' THEN 'м²'
  WHEN 'm3' THEN 'м³' WHEN 'm³' THEN 'м³' WHEN 'м3' THEN 'м³'
  WHEN 'l' THEN 'л' WHEN 'л.' THEN 'л'
  WHEN 'day' THEN 'дн' WHEN 'days' THEN 'дн' WHEN 'дн.' THEN 'дн'
  ELSE uom END WHERE uom IS NOT NULL;

UPDATE rfq_items SET uom = CASE LOWER(uom)
  WHEN 'pcs' THEN 'шт' WHEN 'pc' THEN 'шт' WHEN 'piece' THEN 'шт' WHEN 'шт.' THEN 'шт'
  WHEN 'set' THEN 'компл' WHEN 'kit' THEN 'компл' WHEN 'компл.' THEN 'компл'
  WHEN 'kg' THEN 'кг' WHEN 'кг.' THEN 'кг'
  WHEN 'g' THEN 'г' WHEN 'г.' THEN 'г'
  WHEN 't' THEN 'т' WHEN 'т.' THEN 'т'
  WHEN 'm' THEN 'м' WHEN 'cm' THEN 'см' WHEN 'mm' THEN 'мм'
  WHEN 'm2' THEN 'м²' WHEN 'm²' THEN 'м²' WHEN 'м2' THEN 'м²'
  WHEN 'm3' THEN 'м³' WHEN 'm³' THEN 'м³' WHEN 'м3' THEN 'м³'
  WHEN 'l' THEN 'л' WHEN 'л.' THEN 'л'
  WHEN 'day' THEN 'дн' WHEN 'days' THEN 'дн' WHEN 'дн.' THEN 'дн'
  ELSE uom END WHERE uom IS NOT NULL;

UPDATE rfq_coverage_option_lines SET uom = CASE LOWER(uom)
  WHEN 'pcs' THEN 'шт' WHEN 'pc' THEN 'шт' WHEN 'piece' THEN 'шт' WHEN 'шт.' THEN 'шт'
  WHEN 'set' THEN 'компл' WHEN 'kit' THEN 'компл' WHEN 'компл.' THEN 'компл'
  WHEN 'kg' THEN 'кг' WHEN 'кг.' THEN 'кг'
  WHEN 'g' THEN 'г' WHEN 'г.' THEN 'г'
  WHEN 't' THEN 'т' WHEN 'т.' THEN 'т'
  WHEN 'm' THEN 'м' WHEN 'cm' THEN 'см' WHEN 'mm' THEN 'мм'
  WHEN 'm2' THEN 'м²' WHEN 'm²' THEN 'м²' WHEN 'м2' THEN 'м²'
  WHEN 'm3' THEN 'м³' WHEN 'm³' THEN 'м³' WHEN 'м3' THEN 'м³'
  WHEN 'l' THEN 'л' WHEN 'л.' THEN 'л'
  WHEN 'day' THEN 'дн' WHEN 'days' THEN 'дн' WHEN 'дн.' THEN 'дн'
  ELSE uom END WHERE uom IS NOT NULL;

UPDATE client_request_revision_items SET uom = CASE LOWER(uom)
  WHEN 'pcs' THEN 'шт' WHEN 'pc' THEN 'шт' WHEN 'piece' THEN 'шт' WHEN 'шт.' THEN 'шт'
  WHEN 'set' THEN 'компл' WHEN 'kit' THEN 'компл' WHEN 'компл.' THEN 'компл'
  WHEN 'kg' THEN 'кг' WHEN 'кг.' THEN 'кг'
  WHEN 'g' THEN 'г' WHEN 'г.' THEN 'г'
  WHEN 't' THEN 'т' WHEN 'т.' THEN 'т'
  WHEN 'm' THEN 'м' WHEN 'cm' THEN 'см' WHEN 'mm' THEN 'мм'
  WHEN 'm2' THEN 'м²' WHEN 'm²' THEN 'м²' WHEN 'м2' THEN 'м²'
  WHEN 'm3' THEN 'м³' WHEN 'm³' THEN 'м³' WHEN 'м3' THEN 'м³'
  WHEN 'l' THEN 'л' WHEN 'л.' THEN 'л'
  WHEN 'day' THEN 'дн' WHEN 'days' THEN 'дн' WHEN 'дн.' THEN 'дн'
  ELSE uom END WHERE uom IS NOT NULL;
