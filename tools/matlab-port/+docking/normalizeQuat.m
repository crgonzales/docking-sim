function q = normalizeQuat(q)
%NORMALIZEQUAT Normalize a scalar-first Hamilton quaternion.
q = q(:);
if numel(q) ~= 4 || any(~isfinite(q))
    error('docking:InvalidQuaternion', 'Quaternion must be a finite 4x1 vector.');
end
normQ = norm(q);
if normQ == 0
    q = [1; 0; 0; 0];
else
    q = q / normQ;
end
end
