function q = hillFromInertial(t_s, meanMotionRadS)
%HILLFROMINERTIAL Return q_IH, the +z rotation from Hill to inertial.
if nargin < 2 || isempty(meanMotionRadS)
    meanMotionRadS = sqrt(3.986004418e14 / (6.371e6 + 400e3)^3);
end
if ~isscalar(t_s) || ~isfinite(t_s) || ~isscalar(meanMotionRadS) || ~isfinite(meanMotionRadS)
    error('docking:InvalidFrame', 'Frame time and mean motion must be finite scalars.');
end
angle = meanMotionRadS * t_s;
q = [cos(angle/2); 0; 0; sin(angle/2)];
end
