# must install colima to run oracle-xe server on m1 hardware, see https://hub.docker.com/r/gvenzl/oracle-xe
colima start --arch x86_64 --memory 4 && ./test.sh
colima stop
