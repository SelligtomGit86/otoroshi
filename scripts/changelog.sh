

curl -H "Authorization: bearer ${GITHUB_TOKEN}" \
  -X POST -d '{"query":"{\n  repository(owner: \"MAIF\", name: \"otoroshi\") {\n    milestone(number: 74) {\n      id\n      issues(first: 500) {\n        edges {\n          node {\n            number,\n   title\n          }\n        }\n      }\n    }\n  }\n}","variables":null}' https://api.github.com/graphql | jqn 'at("data.repository.milestone.issues.edges") | map(a => a.map(i => i.node.title + " (#" + i.node.number + ")" ))'

#   -X POST -d '{"query":"{\n  repository(owner: \"MAIF\", name: \"otoroshi\") {\n    milestone(number: 6) {\n      id\n      issues(first: 500, labels: [\"1.5.0-rc.4\"]) {\n        edges {\n          node {\n            number,\n   title\n          }\n        }\n      }\n    }\n  }\n}","variables":null}' https://api.github.com/graphql | jqn 'at("data.repository.milestone.issues.edges") | map(a => a.map(i => i.node.title + " (#" + i.node.number + ")" ))'
