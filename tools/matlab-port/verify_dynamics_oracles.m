function metrics = verify_dynamics_oracles(step, n, inertia)
% Independent physical checks for the native nonlinear plant.
% step(t,x,aBody,tauBody,mdot,dt,n,inertia) returns the next 14x1 state.
% Supplying a narrow adapter keeps these tests independent of the port API.

x0 = [10;-100;3;0.01;0.02;-0.03;1;0;0;0;0;0;0;24];
x = x0;
dt = 1;
count = ceil(2*pi/n/dt);
for k = 0:count-1
    x = step(k*dt,x,zeros(3,1),zeros(3,1),0,dt,n,inertia);
end
% This matrix is constructed independently, not taken from the fixture or
% production CW helper. Matrix exponential is a separate integration oracle.
A = zeros(6);
A(1:3,4:6) = eye(3);
A(4,1) = 3*n*n; A(4,5) = 2*n;
A(5,4) = -2*n; A(6,3) = -n*n;
exact = expm(A*(count*dt))*x0(1:6);
metrics.orbitDuration_s = count*dt;
metrics.cwPositionError_m = max(abs(x(1:3)-exact(1:3)));
metrics.cwVelocityError_mps = max(abs(x(4:6)-exact(4:6)));
assert(metrics.cwPositionError_m < 1e-5,'CW position oracle failed');
assert(metrics.cwVelocityError_mps < 1e-7,'CW velocity oracle failed');

% Full inertial vector conservation, with all three principal inertias unequal.
I = [430;610;780];
x = x0; x(7:10) = [0.5;0.5;0.5;0.5]; x(11:13) = [0.07;-0.11;0.05];
H0 = bodyToInertialMatrix(x(7:10))*(I.*x(11:13));
E0 = 0.5*sum(I.*x(11:13).^2);
maxH = 0; maxE = 0; maxQ = 0;
dt = 0.01;
for k = 0:5999
    x = step(19+k*dt,x,zeros(3,1),zeros(3,1),0,dt,n,I);
    H = bodyToInertialMatrix(x(7:10))*(I.*x(11:13));
    E = 0.5*sum(I.*x(11:13).^2);
    maxH = max(maxH,norm(H-H0)/norm(H0));
    maxE = max(maxE,abs(E-E0)/E0);
    maxQ = max(maxQ,abs(norm(x(7:10))-1));
end
metrics.inertialMomentumRelativeDrift = maxH;
metrics.rotationalEnergyRelativeDrift = maxE;
metrics.quaternionNormError = maxQ;
assert(maxH < 1e-8,'Inertial angular momentum oracle failed');
assert(maxE < 1e-8,'Rotational energy oracle failed');
assert(maxQ < 1e-12,'Quaternion unit norm oracle failed');

% q_BI = +90 degrees about z maps body +x into inertial/Hill -y.
% n=0 isolates this sign convention from orbital rotation and CW coupling.
x = zeros(14,1); x(7:10) = [sqrt(0.5);0;0;sqrt(0.5)]; x(14) = 24;
x = step(0,x,[1;0;0],zeros(3,1),0,0.01,0,inertia);
metrics.rotationPositionError_m = norm(x(1:3)-[0;-0.00005;0]);
metrics.rotationVelocityError_mps = norm(x(4:6)-[0;-0.01;0]);
assert(metrics.rotationPositionError_m < 1e-12,'Force rotation position sign failed');
assert(metrics.rotationVelocityError_mps < 1e-12,'Force rotation velocity sign failed');

% Rotation about a principal axis, initially at rest: omega=alpha*t and
% inertial-to-body quaternion has negative vector part for positive omega.
x = zeros(14,1); x(7) = 1; x(14) = 24;
tau = [0;0;12]; dt = 0.01; angle = 0.5*(tau(3)/inertia(3))*dt^2;
x = step(0,x,zeros(3,1),tau,0,dt,0,inertia);
qExact = [cos(angle/2);0;0;-sin(angle/2)];
metrics.principalTorqueRateError_rps = norm(x(11:13)-tau./inertia*dt);
metrics.principalTorqueQuaternionError = min(norm(x(7:10)-qExact),norm(x(7:10)+qExact));
assert(metrics.principalTorqueRateError_rps < 1e-12,'Principal torque scale failed');
assert(metrics.principalTorqueQuaternionError < 1e-12,'Quaternion derivative sign failed');

% The plant's fuel bookkeeping clamps at zero. The actuator must separately
% scale force/torque when the available fuel cannot supply a complete pulse.
x(14) = 0.001;
x = step(0,x,zeros(3,1),zeros(3,1),1,0.01,0,inertia);
assert(x(14) == 0,'Plant propellant floor failed');
metrics.propellantFloor_kg = x(14);
end

function R_IB = bodyToInertialMatrix(q)
% Explicit matrix formula, independently of production quaternion helpers.
q = q/norm(q); w=q(1); x=q(2); y=q(3); z=q(4);
R_BI = [1-2*(y*y+z*z), 2*(x*y-w*z), 2*(x*z+w*y); ...
        2*(x*y+w*z), 1-2*(x*x+z*z), 2*(y*z-w*x); ...
        2*(x*z-w*y), 2*(y*z+w*x), 1-2*(x*x+y*y)];
R_IB = R_BI';
end
