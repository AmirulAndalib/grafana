package cloudwatch

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/credentials"
	"github.com/aws/aws-sdk-go/aws/credentials/ec2rolecreds"
	"github.com/aws/aws-sdk-go/aws/credentials/endpointcreds"
	"github.com/aws/aws-sdk-go/aws/ec2metadata"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/sts"
	m "github.com/grafana/grafana/pkg/models"
)

type cwRequest struct {
	Region     string `json:"region"`
	Action     string `json:"action"`
	Body       []byte `json:"-"`
	DataSource *m.DataSource
}

type DatasourceInfo struct {
	Profile       string
	Region        string
	AuthType      string
	AssumeRoleArn string
	Namespace     string

	AccessKey string
	SecretKey string
}

func (req *cwRequest) GetDatasourceInfo() *DatasourceInfo {
	authType := req.DataSource.JsonData.Get("authType").MustString()
	assumeRoleArn := req.DataSource.JsonData.Get("assumeRoleArn").MustString()
	accessKey := ""
	secretKey := ""

	for key, value := range req.DataSource.SecureJsonData.Decrypt() {
		if key == "accessKey" {
			accessKey = value
		}
		if key == "secretKey" {
			secretKey = value
		}
	}

	return &DatasourceInfo{
		AuthType:      authType,
		AssumeRoleArn: assumeRoleArn,
		Region:        req.Region,
		Profile:       req.DataSource.Database,
		AccessKey:     accessKey,
		SecretKey:     secretKey,
	}
}

type cache struct {
	credential *credentials.Credentials
	expiration *time.Time
}

var awsCredentialCache map[string]cache = make(map[string]cache)
var credentialCacheLock sync.RWMutex

func GetCredentials(dsInfo *DatasourceInfo) (*credentials.Credentials, error) {
	cacheKey := dsInfo.AccessKey + ":" + dsInfo.Profile + ":" + dsInfo.AssumeRoleArn
	credentialCacheLock.RLock()
	if _, ok := awsCredentialCache[cacheKey]; ok {
		if awsCredentialCache[cacheKey].expiration != nil &&
			(*awsCredentialCache[cacheKey].expiration).After(time.Now().UTC()) {
			result := awsCredentialCache[cacheKey].credential
			credentialCacheLock.RUnlock()
			return result, nil
		}
	}
	credentialCacheLock.RUnlock()

	accessKeyId := ""
	secretAccessKey := ""
	sessionToken := ""
	var expiration *time.Time
	expiration = nil
	if dsInfo.AuthType == "arn" && strings.Index(dsInfo.AssumeRoleArn, "arn:aws:iam:") == 0 {
		params := &sts.AssumeRoleInput{
			RoleArn:         aws.String(dsInfo.AssumeRoleArn),
			RoleSessionName: aws.String("GrafanaSession"),
			DurationSeconds: aws.Int64(900),
		}

		stsSess, err := session.NewSession()
		if err != nil {
			return nil, err
		}
		stsCreds := credentials.NewChainCredentials(
			[]credentials.Provider{
				&credentials.EnvProvider{},
				&credentials.SharedCredentialsProvider{Filename: "", Profile: dsInfo.Profile},
				remoteCredProvider(stsSess),
			})
		stsConfig := &aws.Config{
			Region:      aws.String(dsInfo.Region),
			Credentials: stsCreds,
		}

		sess, err := session.NewSession(stsConfig)
		if err != nil {
			return nil, err
		}
		svc := sts.New(sess, stsConfig)
		resp, err := svc.AssumeRole(params)
		if err != nil {
			return nil, err
		}
		if resp.Credentials != nil {
			accessKeyId = *resp.Credentials.AccessKeyId
			secretAccessKey = *resp.Credentials.SecretAccessKey
			sessionToken = *resp.Credentials.SessionToken
			expiration = resp.Credentials.Expiration
		}
	} else {
		now := time.Now()
		e := now.Add(5 * time.Minute)
		expiration = &e
	}

	sess, err := session.NewSession()
	if err != nil {
		return nil, err
	}
	creds := credentials.NewChainCredentials(
		[]credentials.Provider{
			&credentials.StaticProvider{Value: credentials.Value{
				AccessKeyID:     accessKeyId,
				SecretAccessKey: secretAccessKey,
				SessionToken:    sessionToken,
			}},
			&credentials.EnvProvider{},
			&credentials.StaticProvider{Value: credentials.Value{
				AccessKeyID:     dsInfo.AccessKey,
				SecretAccessKey: dsInfo.SecretKey,
			}},
			&credentials.SharedCredentialsProvider{Filename: "", Profile: dsInfo.Profile},
			remoteCredProvider(sess),
		})

	credentialCacheLock.Lock()
	awsCredentialCache[cacheKey] = cache{
		credential: creds,
		expiration: expiration,
	}
	credentialCacheLock.Unlock()

	return creds, nil
}

func remoteCredProvider(sess *session.Session) credentials.Provider {
	ecsCredURI := os.Getenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")

	if len(ecsCredURI) > 0 {
		return ecsCredProvider(sess, ecsCredURI)
	}
	return ec2RoleProvider(sess)
}

func ecsCredProvider(sess *session.Session, uri string) credentials.Provider {
	const host = `169.254.170.2`

	c := ec2metadata.New(sess)
	return endpointcreds.NewProviderClient(
		c.Client.Config,
		c.Client.Handlers,
		fmt.Sprintf("http://%s%s", host, uri),
		func(p *endpointcreds.Provider) { p.ExpiryWindow = 5 * time.Minute })
}

func ec2RoleProvider(sess *session.Session) credentials.Provider {
	return &ec2rolecreds.EC2RoleProvider{Client: ec2metadata.New(sess), ExpiryWindow: 5 * time.Minute}
}

func getAwsConfig(req *cwRequest) (*aws.Config, error) {
	creds, err := GetCredentials(req.GetDatasourceInfo())
	if err != nil {
		return nil, err
	}

	cfg := &aws.Config{
		Region:      aws.String(req.Region),
		Credentials: creds,
	}
	return cfg, nil
}
